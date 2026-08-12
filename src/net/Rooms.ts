/** Rooms — P2 friend link-up over Supabase Realtime. A room IS a channel
 *  (`cod-room-<CODE>`): no server state, no table, no GC — the room exists
 *  exactly while its members' sockets do, and dies with the host. The code
 *  is the secret; presence carries {callsign, role, ready}; a `launch`
 *  broadcast starts PARALLEL OPS (each side runs its own solo sim, live
 *  status streamed at 1Hz — the co-op sim itself is Phase 3).
 *
 *  Leaf module (FieldReport pattern): no imports from ui/ or game systems.
 *  The UI drives it through RoomHandle callbacks; main.ts feeds sendStatus.
 *
 *  Race rules encoded here (the subtle part):
 *  - Room existence = a `host`-role member visible after presence sync.
 *  - Two guests racing an almost-full room: deterministic self-ejection —
 *    every guest sorts all guest clientIds; if it isn't first, IT leaves
 *    (both sides converge without a coordinator).
 *  - `launch` is honored only from the host's clientId.
 *  - Host leave in lobby → guests see `closed`. Any leave mid-run → the
 *    partner chip's SIGNAL LOST state (presence leave event). */
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js';

const REALTIME_URL = 'wss://rkogeqpqbimawiwtmdkp.supabase.co/realtime/v1';
// Publishable key — public by design (tables are RLS deny-all; channels are
// public-broadcast and the room code is the only secret worth having here).
const REALTIME_KEY = 'sb_publishable_cjn2C1H7gp31JPA6I3vUMQ_HzwEQwmq';

// No 0/O/1/I — codes get read aloud over voice chat and typed from phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export type RoomRole = 'host' | 'guest';
export type RoomPhase = 'lobby' | 'launched' | 'closed';

export interface PartnerInfo {
  callsign: string;
  ready: boolean;
}

export interface RoomState {
  code: string;
  role: RoomRole;
  phase: RoomPhase;
  selfReady: boolean;
  partner: PartnerInfo | null;
  /** Set when phase becomes 'closed': why the room ended. */
  closedReason?: 'host-left' | 'ejected-full' | 'left';
}

export interface PartnerStatus {
  wave: number;
  score: number;
  hp: number;
  alive: boolean;
}

export interface RoomHandle {
  readonly code: string;
  readonly role: RoomRole;
  readonly shareUrl: string;
  onState(cb: (s: RoomState) => void): void;
  onLaunch(cb: () => void): void;
  onPartnerStatus(cb: (st: PartnerStatus | null) => void): void;
  setReady(ready: boolean): void;
  /** Host only; no-op until both sides are ready. */
  launch(): void;
  /** Throttled internally to 1Hz — call as often as convenient. */
  sendStatus(st: PartnerStatus): void;
  leave(): void;
}

interface Identity {
  callsign: string;
  clientId: string;
}

/** Presence carries IDENTITY only and is tracked exactly once. Mutable
 *  lobby state (ready) rides broadcasts instead: measured on the live
 *  service (.tmp/rooms-transport-test.mjs), presence updates gossip across
 *  Realtime cluster nodes with multi-second lag (2/3 runs missed a 1.2s
 *  deadline) while broadcasts landed instantly 5/5. Presence answers "who
 *  is in the room"; broadcasts answer "what changed". */
type PresenceMeta = {
  callsign: string;
  role: RoomRole;
  clientId: string;
  /** Fixed forever at join — the eviction tie-break's seniority. */
  joinedAt: number;
};

let getIdentity: (() => Identity) | null = null;
let client: RealtimeClient | null = null;

export function configureRooms(identityProvider: () => Identity): void {
  getIdentity = identityProvider;
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

export function parseRoomFromUrl(): string | null {
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
  return isValidCode(code) ? code : null;
}

export function generateCode(): string {
  const buf = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

function ensureClient(): RealtimeClient {
  if (!client) {
    client = new RealtimeClient(REALTIME_URL, { params: { apikey: REALTIME_KEY } });
  }
  return client;
}

export function createRoom(): Promise<RoomHandle> {
  return openRoom(generateCode(), 'host');
}

export function joinRoom(code: string): Promise<RoomHandle> {
  return openRoom(code.toUpperCase(), 'guest');
}

/** Rejects with Error whose message is one of: 'not-found' | 'full' |
 *  'no-identity' | 'connect-failed' — the UI maps these to copy. */
function openRoom(code: string, role: RoomRole): Promise<RoomHandle> {
  if (!getIdentity) return Promise.reject(new Error('no-identity'));
  const me = getIdentity();
  const rt = ensureClient();
  const channel: RealtimeChannel = rt.channel(`cod-room-${code}`, {
    config: { presence: { key: me.clientId }, broadcast: { self: false } },
  });

  const state: RoomState = { code, role, phase: 'lobby', selfReady: false, partner: null };
  /** Join-settlement plumbing: close() must be able to REJECT a pending
   *  join — a room that closes before the join settles would otherwise
   *  leave the promise hanging forever (builder-caught: the guest's own
   *  track() syncs a hostless roster, and the old code closed the room
   *  pre-settle, which then muted the not-found deadline). */
  let settled = false;
  let rejectJoin: ((e: Error) => void) | null = null;
  let stateCb: ((s: RoomState) => void) | null = null;
  let launchCb: (() => void) | null = null;
  let statusCb: ((st: PartnerStatus | null) => void) | null = null;
  let hostClientId: string | null = role === 'host' ? me.clientId : null;
  let lastStatusSentAt = 0;
  let closed = false;
  const joinedAt = Date.now();
  /** clientId -> last broadcast ready state (presence is identity-only). */
  const readyMap = new Map<string, boolean>();
  let partnerClientId: string | null = null;
  const emit = (): void => stateCb?.({ ...state });

  const broadcastReady = (): void => {
    void channel.send({ type: 'broadcast', event: 'ready', payload: { from: me.clientId, ready: state.selfReady } });
  };

  const close = (reason: RoomState['closedReason']): void => {
    if (closed) return;
    closed = true;
    state.phase = 'closed';
    state.closedReason = reason;
    void channel.untrack();
    void rt.removeChannel(channel);
    if (!settled) {
      settled = true;
      rejectJoin?.(new Error(reason === 'ejected-full' ? 'full' : reason === 'host-left' ? 'not-found' : 'connect-failed'));
    }
    emit();
  };

  /** Presence is the single source of truth — recompute everything from the
   *  full member list on every sync (deltas alone miss the initial roster). */
  const readRoster = (): void => {
    if (closed) return;
    const presences = Object.values(channel.presenceState<PresenceMeta>()).flat();
    const host = presences.find((p) => p.role === 'host');
    hostClientId = host?.clientId ?? hostClientId;

    if (role === 'guest') {
      if (!host) {
        // Pre-settle, a hostless roster is EXPECTED for a beat (our own
        // track syncs before the host's state gossips over) — the join
        // deadline below is the only judge of not-found. Post-join in
        // lobby, a vanished host closes the room. Post-launch we keep the
        // channel for the partner chip; SIGNAL LOST is not closure.
        if (!settled) return;
        if (state.phase === 'lobby') close('host-left');
        else {
          state.partner = null;
          statusCb?.(null);
          emit();
        }
        return;
      }
      const guests = presences
        .filter((p) => p.role === 'guest')
        .sort((a, b) => a.joinedAt - b.joinedAt || a.clientId.localeCompare(b.clientId));
      if (guests.length > 1 && guests[0]?.clientId !== me.clientId) {
        close('ejected-full');
        return;
      }
    }
    const candidates = presences
      .filter((p) => p.clientId !== me.clientId && (role === 'host' ? p.role === 'guest' : p.role === 'host'))
      .sort((a, b) => a.joinedAt - b.joinedAt || a.clientId.localeCompare(b.clientId));
    const partner = candidates[0];
    const hadPartner = state.partner !== null;
    const isNewPartner = partner !== undefined && partner.clientId !== partnerClientId;
    partnerClientId = partner?.clientId ?? null;
    state.partner = partner
      ? { callsign: partner.callsign, ready: readyMap.get(partner.clientId) ?? false }
      : null;
    if (hadPartner && !partner) statusCb?.(null);
    // A fresh partner missed every earlier ready broadcast — catch them up.
    if (isNewPartner) broadcastReady();
    emit();
  };

  const track = (): Promise<unknown> =>
    channel.track({ callsign: me.callsign, role, clientId: me.clientId, joinedAt } satisfies PresenceMeta);

  return new Promise<RoomHandle>((resolve, reject) => {
    rejectJoin = reject;
    channel
      .on('presence', { event: 'sync' }, () => {
        // A guest's join resolves the moment the host shows up — the 2.5s
        // timer below is only the NOT-FOUND deadline, not a fixed wait.
        if (!settled && !closed && role === 'guest') {
          const ps = Object.values(channel.presenceState<PresenceMeta>()).flat();
          if (ps.some((p) => p.role === 'host')) {
            settled = true;
            resolve(handle);
          }
        }
        readRoster();
      })
      .on('broadcast', { event: 'launch' }, ({ payload }) => {
        if (closed || state.phase !== 'lobby') return;
        if ((payload as { from?: string }).from !== hostClientId) return;
        state.phase = 'launched';
        emit();
        launchCb?.();
      })
      .on('broadcast', { event: 'ready' }, ({ payload }) => {
        if (closed) return;
        const p = payload as { from?: string; ready?: boolean };
        if (!p.from || p.from === me.clientId) return;
        readyMap.set(p.from, p.ready === true);
        if (p.from === partnerClientId && state.partner) {
          state.partner = { ...state.partner, ready: p.ready === true };
          emit();
        }
      })
      .on('broadcast', { event: 'status' }, ({ payload }) => {
        if (closed) return;
        const p = payload as PartnerStatus & { from?: string };
        if (p.from === me.clientId) return;
        statusCb?.({ wave: p.wave, score: p.score, hp: p.hp, alive: p.alive });
      })
      .subscribe((status) => {
        if (settled) return;
        if (status === 'SUBSCRIBED') {
          void track().then(() => {
            // Guests give presence one sync beat to reveal the host before
            // ruling the room dead — sync can land before OR after track.
            if (role === 'guest') {
              // 4s NOT-FOUND deadline: cross-node presence gossip can lag a
              // couple of seconds (measured); the sync handler above resolves
              // early the moment the host appears, so real joins stay snappy.
              setTimeout(() => {
                if (settled || closed) return;
                const presences = Object.values(channel.presenceState<PresenceMeta>()).flat();
                if (!presences.some((p) => p.role === 'host')) {
                  settled = true;
                  close('left');
                  reject(new Error('not-found'));
                  return;
                }
                settled = true;
                resolve(handle);
                readRoster();
              }, 4000);
            } else {
              settled = true;
              resolve(handle);
            }
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          settled = true;
          close('left');
          reject(new Error('connect-failed'));
        }
      });

    const handle: RoomHandle = {
      code,
      role,
      shareUrl: `${location.origin}/?room=${code}`,
      onState: (cb) => { stateCb = cb; emit(); },
      onLaunch: (cb) => { launchCb = cb; },
      onPartnerStatus: (cb) => { statusCb = cb; },
      setReady: (ready) => {
        state.selfReady = ready;
        broadcastReady();
        emit();
      },
      launch: () => {
        if (role !== 'host' || state.phase !== 'lobby') return;
        if (!state.selfReady || !state.partner?.ready) return;
        state.phase = 'launched';
        void channel.send({ type: 'broadcast', event: 'launch', payload: { from: me.clientId } });
        emit();
        launchCb?.();
      },
      sendStatus: (st) => {
        if (closed || state.phase !== 'launched') return;
        const now = performance.now();
        if (now - lastStatusSentAt < 1000) return;
        lastStatusSentAt = now;
        void channel.send({ type: 'broadcast', event: 'status', payload: { ...st, from: me.clientId } });
      },
      leave: () => close('left'),
    };
  });
}
