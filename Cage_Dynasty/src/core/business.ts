/**
 * Money and broadcasting.
 *
 * Every event earns a gate (tickets in the event's region) and, depending on
 * how it's broadcast, TV money or PPV money, plus sponsors; it costs purses,
 * production and the venue. A promotion can sign TV deals with networks or
 * launch its own network (subscribers), and sell PPV through a partner
 * platform (they keep a cut, bigger reach) or its own (keep most, smaller
 * reach). Each event is TV or PPV, so running both is the hybrid model; PPV
 * prelims air on TV when there's an outlet. All networks are fictional.
 */
import { WEEKS_PER_YEAR, type Tier } from "./constants.js";
import { MAIN_CARD_SIZE } from "./excitement.js";
import type { FighterState, PromotionState } from "./model.js";
import { addPop, popIn } from "./popularity.js";
import { hash } from "./profile.js";
import { LOCAL_TV_REACH } from "./schedule.js";
import type { World } from "./world.js";

/** Prepared statements are cached per database: settling runs for every event in the world. */
type Stmt = { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
const stmtCache = new WeakMap<object, Map<string, Stmt>>();
function q(world: World, sql: string): Stmt {
  let m = stmtCache.get(world.db);
  if (!m) { m = new Map(); stmtCache.set(world.db, m); }
  let st = m.get(sql);
  if (!st) { st = world.db.prepare(sql) as unknown as Stmt; m.set(sql, st); }
  return st;
}

export interface Network { id: number; name: string; kind: "tv" | "ppv"; reach: number; minBrand: number; cut: number }
export const NETWORKS: Network[] = [
  { id: 1, name: "Northlight Sports", kind: "tv", reach: 85, minBrand: 60, cut: 0 },
  { id: 2, name: "Atlas Broadcasting", kind: "tv", reach: 65, minBrand: 38, cut: 0 },
  { id: 3, name: "Harbor TV", kind: "tv", reach: 45, minBrand: 18, cut: 0 },
  { id: 4, name: "Vantage One", kind: "tv", reach: 25, minBrand: 0, cut: 0 },
  { id: 5, name: "Ringside Direct", kind: "ppv", reach: 85, minBrand: 50, cut: 0.5 },
  { id: 6, name: "PayView Network", kind: "ppv", reach: 60, minBrand: 22, cut: 0.4 },
];

export const VENUES = [
  { key: "hall", name: "Hall", capacity: 1200, rent: 8_000 },
  { key: "club", name: "Club", capacity: 3000, rent: 40_000 },
  { key: "arena", name: "Arena", capacity: 12000, rent: 200_000 },
  { key: "big_arena", name: "Big arena", capacity: 20000, rent: 450_000 },
  { key: "stadium", name: "Stadium", capacity: 50000, rent: 1_500_000 },
] as const;
export type VenueKey = (typeof VENUES)[number]["key"];
export type Broadcast = "tv" | "ppv" | "none";

const AI_OWN_NETWORK_REACH: Record<Tier, number> = { global: 55, major: 35, regional: 18, local: 8 };

/** Tuning for the money model. */
export const MONEY = {
  startingCash: { global: 40_000_000, major: 6_000_000, regional: 1_500_000, local: 300_000 } as Record<Tier, number>,
  ppvPrice: 59.99,
  ownNetworkLaunch: 5_000_000,
  ownNetworkWeekly: 60_000,
  ownNetworkPrice: 9.99,       // per month
  ownPpvLaunch: 2_000_000,
  ownPpvShare: 0.9,
  ownPpvMarketing: 150_000,    // per PPV
  production: { tv: 150_000, ppv: 300_000, none: 30_000 } as Record<Broadcast, number>,
  /** Smaller shows produce for less (local crews, fewer cameras). */
  productionScale: { global: 1, major: 0.8, regional: 0.35, local: 0.12 } as Record<Tier, number>,
  /** AI promotions' running costs per card run, charged yearly: staff, offices, marketing, fighter benefits. */
  /** Share of profit above overhead that AI promotions spend each year rather than bank. */
  reinvest: 0.75,
  overheadPerCard: { global: 1_000_000, major: 700_000, regional: 120_000, local: 8_000 } as Record<Tier, number>,
  churnPerWeek: 0.012,
};

// ------------------------------------------------------------------ deals

export interface Deal { id: number; promotionId: number; networkId: number | null; kind: "tv" | "ppv"; startWeek: number; endWeek: number; eventsPerYear: number; feePerEvent: number; share: number; eventsThisYear: number }
export interface Offer { networkId: number; network: string; kind: "tv" | "ppv"; reach: number; years: number; eventsPerYear: number; feePerEvent: number; share: number }

/** How big a promotion's name is: tier, its stars, its history. 0-100. */
export function brand(world: World, p: PromotionState): number {
  const base = { global: 62, major: 34, regional: 14, local: 4 }[p.tier];
  const stars = [...p.roster].map((id) => world.fighters.get(id)?.popularity ?? 0).sort((a, b) => b - a).slice(0, 10);
  const avg = stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : 0;
  return Math.round(Math.min(100, base + avg * 0.45));
}

export function deals(world: World, promotionId: number): Deal[] {
  return (world.db.prepare(`SELECT id, promotion_id AS promotionId, network_id AS networkId, kind, start_week AS startWeek, end_week AS endWeek,
                                   events_per_year AS eventsPerYear, fee_per_event AS feePerEvent, share, events_this_year AS eventsThisYear
                            FROM broadcast_deal WHERE promotion_id = ? AND end_week > ?`).all(promotionId, world.week)) as Deal[];
}

export function offers(world: World, p: PromotionState): Offer[] {
  const b = brand(world, p);
  const have = deals(world, p.id);
  return NETWORKS.filter((n) => b >= n.minBrand && !have.some((d) => d.networkId === n.id)).map((n) => n.kind === "tv"
    ? { networkId: n.id, network: n.name, kind: "tv" as const, reach: n.reach, years: 3, eventsPerYear: n.reach >= 60 ? 16 : 12,
        feePerEvent: Math.round((n.reach * b * 95) / 1000) * 1000, share: 0 }
    : { networkId: n.id, network: n.name, kind: "ppv" as const, reach: n.reach, years: 2, eventsPerYear: 0, feePerEvent: 0, share: 1 - n.cut });
}

export function signDeal(world: World, p: PromotionState, networkId: number) {
  const o = offers(world, p).find((x) => x.networkId === networkId);
  if (!o) throw new Error("That network isn't offering you a deal");
  // One TV partner and one PPV partner at a time.
  if (deals(world, p.id).some((d) => d.kind === o.kind && d.networkId !== null)) throw new Error(`You already have a ${o.kind.toUpperCase()} partner`);
  world.db.prepare(`INSERT INTO broadcast_deal (promotion_id, network_id, kind, start_week, end_week, events_per_year, fee_per_event, share)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, o.networkId, o.kind, world.week, world.week + o.years * WEEKS_PER_YEAR, o.eventsPerYear, o.feePerEvent, o.share);
  world.repo.news(world.week, p.id, "business", `${p.name} signs a ${o.years}-year ${o.kind === "tv" ? `TV deal with ${o.network}: ${o.eventsPerYear} events a year at $${(o.feePerEvent / 1000).toFixed(0)}k per event` : `PPV deal with ${o.network}, keeping ${Math.round(o.share * 100)}% of buys`}.`, null, 2);
}

export interface OwnMedia { network: boolean; subscribers: number; ppv: boolean; networkName: string | null }
export function ownMedia(world: World, promotionId: number): OwnMedia {
  const r = world.db.prepare("SELECT own_network, own_network_name, subscribers, own_ppv FROM promotion WHERE id = ?").get(promotionId) as
    { own_network: number; own_network_name: string | null; subscribers: number; own_ppv: number };
  return { network: !!r.own_network, subscribers: r.subscribers, ppv: !!r.own_ppv, networkName: r.own_network_name };
}

export function launchOwnNetwork(world: World, p: PromotionState, name: string) {
  if (ownMedia(world, p.id).network) throw new Error("You already run your own network");
  spend(world, p.id, MONEY.ownNetworkLaunch, "Launched own network");
  const start = Math.round(brand(world, p) * 900);
  world.db.prepare("UPDATE promotion SET own_network = 1, own_network_name = ?, subscribers = ? WHERE id = ?").run(name, start, p.id);
  world.repo.news(world.week, p.id, "business", `${p.name} launches its own network, ${name}, with ${start.toLocaleString("en-US")} subscribers on day one.`, null, 2);
}

export function launchOwnPpv(world: World, p: PromotionState) {
  if (ownMedia(world, p.id).ppv) throw new Error("You already run your own PPV platform");
  spend(world, p.id, MONEY.ownPpvLaunch, "Launched own PPV platform");
  world.db.prepare("UPDATE promotion SET own_ppv = 1 WHERE id = ?").run(p.id);
  world.repo.news(world.week, p.id, "business", `${p.name} launches its own PPV platform and keeps ${Math.round(MONEY.ownPpvShare * 100)}% of every buy.`, null, 2);
}

export function cash(world: World, promotionId: number): number {
  return (world.db.prepare("SELECT cash FROM promotion WHERE id = ?").get(promotionId) as { cash: number }).cash;
}
export function spend(world: World, promotionId: number, amount: number, what: string) {
  world.db.prepare("UPDATE promotion SET cash = cash - ? WHERE id = ?").run(amount, promotionId);
  world.db.prepare("INSERT INTO ledger (promotion_id, week, amount, what) VALUES (?, ?, ?, ?)").run(promotionId, world.week, -amount, what);
}
export function earn(world: World, promotionId: number, amount: number, what: string) {
  world.db.prepare("UPDATE promotion SET cash = cash + ? WHERE id = ?").run(amount, promotionId);
  world.db.prepare("INSERT INTO ledger (promotion_id, week, amount, what) VALUES (?, ?, ?, ?)").run(promotionId, world.week, amount, what);
}

/** Which broadcast options a promotion has right now. */
export function outlets(world: World, p: PromotionState) {
  const d = deals(world, p.id), own = ownMedia(world, p.id);
  const tvDeal = d.find((x) => x.kind === "tv");
  const ppvDeal = d.find((x) => x.kind === "ppv");
  return {
    tv: tvDeal ? { kind: "deal" as const, deal: tvDeal, reach: NETWORKS.find((n) => n.id === tvDeal.networkId)!.reach, name: NETWORKS.find((n) => n.id === tvDeal.networkId)!.name }
      : own.network ? { kind: "own" as const, deal: null, reach: ownReach(own.subscribers), name: own.networkName ?? "own network" } : null,
    ownTv: own.network ? { reach: ownReach(own.subscribers), name: own.networkName ?? "own network", subscribers: own.subscribers } : null,
    ppv: ppvDeal ? { kind: "deal" as const, share: ppvDeal.share, reach: NETWORKS.find((n) => n.id === ppvDeal.networkId)!.reach, name: NETWORKS.find((n) => n.id === ppvDeal.networkId)!.name }
      : own.ppv ? { kind: "own" as const, share: MONEY.ownPpvShare, reach: 30 + Math.min(40, own.subscribers / 6000), name: "own PPV" } : null,
  };
}
/** An owned network reaches as far as its subscriber base. */
const ownReach = (subs: number) => Math.min(70, 10 + subs / 4000);

// ------------------------------------------------------------------ settling an event

export interface EventMoney {
  broadcast: Broadcast; outlet: string | null; venue: string; attendance: number; ticket: number; gate: number;
  ppvBuys: number; ppvRevenue: number; tvViewers: number; tvRevenue: number; sponsors: number;
  purses: number; production: number; venueCost: number; profit: number;
}

const SLOT_WEIGHT = (i: number) => (i === 0 ? 1 : i === 1 ? 0.6 : i < MAIN_CARD_SIZE ? 0.3 : 0.08);

/** Star power of a card in one region (or worldwide when region is null). */
export function cardDraw(bouts: { red: FighterState; blue: FighterState; title: boolean }[], region: number | null): number {
  let d = 0;
  bouts.forEach((b, i) => {
    d += SLOT_WEIGHT(i) * (popIn(b.red, region) + popIn(b.blue, region));
    if (b.title) d += i === 0 ? 18 : 8;
  });
  return d;
}

/** Bigger in some regions than others. */
const marketSize = (region: number | null) => (region === null ? 1 : 0.75 + (hash(region, "market") % 60) / 100);

export function pickVenue(expectedAttendance: number): VenueKey {
  return (VENUES.find((v) => v.capacity >= expectedAttendance * 1.05) ?? VENUES[VENUES.length - 1]!).key;
}

export function expectedAttendance(draw: number, region: number | null, tier: Tier) {
  const tierMult = { global: 2.6, major: 1.0, regional: 0.55, local: 0.3 }[tier];
  return Math.round(marketSize(region) * Math.pow(Math.max(draw, 1) / 100, 1.3) * 2600 * tierMult);
}

export function settleEvent(world: World, p: PromotionState, eventId: number,
  bouts: { red: FighterState; blue: FighterState; title: boolean; winnerId: number | null }[], cardRating: number): EventMoney | null {
  if (bouts.length === 0) return null;
  const isPlayer = p.id === world.playerPromotionId;
  const ev = q(world, "SELECT region_id, broadcast, venue FROM event WHERE id = ?").get(eventId) as { region_id: number | null; broadcast: string | null; venue: string | null };
  const region = ev.region_id;
  const draw = cardDraw(bouts, region);
  const worldDraw = cardDraw(bouts, null);
  const out = outlets(world, p);

  // AI promotions: globals sell their biggest cards on PPV, everyone else on TV of a size to match their tier.
  let broadcast: Broadcast = (ev.broadcast as Broadcast | null) ?? "none";
  let tvReach = 0, ppvReach = 0, ppvShare = 0, outletName: string | null = null;
  if (isPlayer) {
    if (broadcast === "tv" && out.tv) { tvReach = out.tv.reach; outletName = out.tv.name; }
    else if (broadcast === "ppv" && out.ppv) { ppvReach = out.ppv.reach; ppvShare = out.ppv.share; outletName = out.ppv.name; }
    else broadcast = "none";
  } else {
    // The card kind was set when the promotion booked it (see schedule.ts).
    const plan = p.plan;
    if (broadcast !== "ppv" && broadcast !== "tv") broadcast = "none";
    const tvNet = NETWORKS.find((n) => n.id === plan?.tvNetworkId);
    const ppvNet = NETWORKS.find((n) => n.id === plan?.ppvNetworkId);
    tvReach = broadcast === "none" ? 0 : tvNet ? tvNet.reach : plan?.flavor === "own_network" ? AI_OWN_NETWORK_REACH[p.tier] : LOCAL_TV_REACH;
    outletName = broadcast === "none" ? null : broadcast === "ppv" ? ppvNet?.name ?? "PPV" : tvNet?.name ?? (plan?.flavor === "own_network" ? `${p.name} Network` : "local TV");
    ppvReach = ppvNet?.reach ?? 60; ppvShare = 1 - (ppvNet?.cut ?? 0.45);
    if (broadcast === "ppv") tvReach = 0;
  }

  const expected = expectedAttendance(draw, region, p.tier);
  // AI goals: prestige shows book a room a size up, profit shows one they can fill.
  const goal = isPlayer ? null : p.plan?.goal;
  const venueKey = (ev.venue as VenueKey | null) ?? pickVenue(expected * (goal === "prestige" ? 1.35 : goal === "profit" ? 0.85 : 1));
  const venue = VENUES.find((v) => v.key === venueKey)!;
  const jitter = 0.9 + (hash(eventId, "gate") % 200) / 1000;
  const attendance = Math.min(venue.capacity, Math.round(expected * jitter));
  const ticket = Math.round(45 + draw * 0.45 + (venue.capacity >= 20000 ? 15 : 0));
  const gate = attendance * ticket;

  const ppvBuys = broadcast === "ppv" ? Math.round(Math.pow(worldDraw / 100, 2.2) * 22000 * (ppvReach / 80) * jitter) : 0;
  const ppvRevenue = Math.round(ppvBuys * MONEY.ppvPrice * ppvShare);
  // PPV prelims air on the TV outlet when there is one.
  const prelimReach = broadcast === "ppv" ? (isPlayer ? (out.tv?.reach ?? 0) : tvReach) : 0;
  const tvViewers = Math.round((tvReach / 100) * Math.pow(worldDraw / 100, 1.2) * 900_000 * jitter + prelimReach / 100 * 250_000);
  let tvRevenue = 0;
  if (broadcast === "tv" && isPlayer && out.tv?.kind === "deal") tvRevenue = out.tv.deal!.feePerEvent;
  // AI rights fees: a network pays by its reach; an owned network earns subscriptions worth a bit less.
  if (!isPlayer && broadcast === "tv") tvRevenue = Math.round(tvReach * (p.plan?.flavor === "own_network" ? 3200 : { global: 11000, major: 4000, regional: 4000, local: 1500 }[p.tier]));
  const sponsors = Math.round((attendance * 8 + tvViewers * 0.12 + ppvBuys * 2) * (0.6 + cardRating / 100));

  const purses = bouts.reduce((t, b) => t + purseFor(world, b.red, p, b.winnerId) + purseFor(world, b.blue, p, b.winnerId), 0);
  const production = Math.round(MONEY.production[broadcast] * MONEY.productionScale[p.tier]) + (broadcast === "ppv" && out.ppv?.kind === "own" && isPlayer ? MONEY.ownPpvMarketing : 0);
  const profit = gate + ppvRevenue + tvRevenue + sponsors - purses - production - venue.rent;

  q(world, `UPDATE event SET broadcast = ?, venue = ?, attendance = ?, gate = ?, ppv_buys = ?, ppv_revenue = ?, tv_viewers = ?, tv_revenue = ?,
                    sponsors = ?, costs = ?, profit = ? WHERE id = ?`)
    .run(broadcast, venue.key, attendance, gate, ppvBuys, ppvRevenue, tvViewers, tvRevenue, sponsors, purses + production + venue.rent, profit, eventId);

  // Exposure: TV puts fighters in front of new fans everywhere; a big crowd builds the local market.
  const exposure = tvViewers / 1_000_000 + ppvBuys / 400_000;
  if (exposure > 0.05) bouts.forEach((b, i) => { for (const f of [b.red, b.blue]) addPop(f, Math.min(1.5, exposure * SLOT_WEIGHT(i)), null, world.regionIds); });

  if (!isPlayer) q(world, "UPDATE promotion SET cash = cash + ? WHERE id = ?").run(profit, p.id);
  if (isPlayer) {
    world.db.prepare("UPDATE promotion SET cash = cash + ? WHERE id = ?").run(profit, p.id);
    world.db.prepare("INSERT INTO ledger (promotion_id, week, amount, what) VALUES (?, ?, ?, ?)").run(p.id, world.week, profit, `Event ${eventId}`);
    if (broadcast === "tv" && out.tv?.kind === "deal") world.db.prepare("UPDATE broadcast_deal SET events_this_year = events_this_year + 1 WHERE id = ?").run(out.tv.deal!.id);
    if (broadcast === "tv" && out.tv?.kind === "own" || prelimReach && out.tv?.kind === "own") growSubscribers(world, p.id, tvViewers * 0.015);
  }
  return { broadcast, outlet: outletName, venue: venue.name, attendance, ticket, gate, ppvBuys, ppvRevenue, tvViewers, tvRevenue, sponsors, purses, production, venueCost: venue.rent, profit };
}

function purseFor(world: World, f: FighterState, p: PromotionState, winnerId: number | null): number {
  const c = f.contractId !== null ? q(world, "SELECT purse, win_bonus FROM contract WHERE id = ?").get(f.contractId) as { purse: number; win_bonus: number } | undefined : undefined;
  const base = c?.purse ?? world.tierDef.get(p.tier)!.basePurse;
  return base + (winnerId === f.id ? (c?.win_bonus ?? base) : 0);
}

export function growSubscribers(world: World, promotionId: number, n: number) {
  world.db.prepare("UPDATE promotion SET subscribers = MAX(0, subscribers + ?) WHERE id = ?").run(Math.round(n), promotionId);
}

/** Weekly: own-network subscription money and upkeep, churn. */
export function weeklyBusiness(world: World) {
  const p = world.playerPromotion;
  if (!p) return;
  const own = ownMedia(world, p.id);
  if (own.network) {
    const revenue = Math.round(own.subscribers * MONEY.ownNetworkPrice / 4.33);
    earn(world, p.id, revenue - MONEY.ownNetworkWeekly, "Own network: subscriptions less running costs");
    growSubscribers(world, p.id, -own.subscribers * MONEY.churnPerWeek + brand(world, p) * 8);
  }
}

/** Yearly: TV partners check you delivered the events you promised. */
export function yearlyBusiness(world: World) {
  const p = world.playerPromotion;
  if (!p) return;
  for (const d of deals(world, p.id)) {
    if (d.kind === "tv" && d.eventsThisYear < d.eventsPerYear) {
      const short = d.eventsPerYear - d.eventsThisYear;
      const penalty = short * Math.round(d.feePerEvent * 0.5);
      spend(world, p.id, penalty, `TV deal shortfall: ${short} events`);
      world.repo.news(world.week, p.id, "business", `${NETWORKS.find((n) => n.id === d.networkId)?.name} fines you $${(penalty / 1000).toFixed(0)}k: you delivered ${d.eventsThisYear} of the ${d.eventsPerYear} TV events promised this year.`, null, 2);
    }
  }
  world.db.prepare("UPDATE broadcast_deal SET events_this_year = 0 WHERE promotion_id = ?").run(p.id);
}
