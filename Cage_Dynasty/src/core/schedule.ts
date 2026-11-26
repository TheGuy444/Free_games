/**
 * How AI promotions plan their year: a broadcast flavor and a goal per
 * promotion, and a size (tier) that sets how many cards they can run.
 *
 * Big promotions run a card nearly every week: a monthly numbered PPV with TV
 * Fight Nights in between. Small ones run about one card a month on local TV,
 * or untelevised shows, because their numbers can't carry a PPV.
 */
import type { PromotionState } from "./model.js";
import type { Tier } from "./constants.js";
import { WEEKS_PER_YEAR } from "./constants.js";
import { hash } from "./profile.js";

export type CardKind = "ppv" | "tv" | "none";

export const FLAVORS = {
  ppv_led: { label: "PPV-led", blurb: "A numbered PPV every month, with TV Fight Nights in between." },
  hybrid: { label: "Hybrid", blurb: "TV cards most weeks, PPV only for the biggest title fights." },
  all_tv: { label: "All TV", blurb: "Every card on its TV partner; no PPV." },
  own_network: { label: "Own network", blurb: "Streams every card on its own subscription network." },
  grassroots: { label: "Grassroots", blurb: "Small untelevised shows that build local talent." },
} as const;
export type Flavor = keyof typeof FLAVORS;

export const GOALS = {
  prestige: { label: "Prestige", blurb: "Title fights and big rooms; spends to look like the top show." },
  profit: { label: "Profit", blurb: "Fewer, cheaper cards in rooms it can fill." },
  growth: { label: "Growth", blurb: "More cards, and takes shows on the road to new regions." },
  development: { label: "Development", blurb: "Signs young prospects and builds them up." },
} as const;
export type Goal = keyof typeof GOALS;

/** Cards per year by kind, for each size and flavor. */
const PLANS: Record<Tier, Partial<Record<Flavor, { ppv: number; tv: number; none: number; weight: number }>>> = {
  global: {
    ppv_led: { ppv: 12, tv: 30, none: 0, weight: 3 },
    hybrid: { ppv: 5, tv: 33, none: 0, weight: 2 },
    all_tv: { ppv: 0, tv: 38, none: 0, weight: 1 },
  },
  major: {
    hybrid: { ppv: 3, tv: 18, none: 0, weight: 2 },
    all_tv: { ppv: 0, tv: 22, none: 0, weight: 2 },
    own_network: { ppv: 0, tv: 22, none: 0, weight: 1 },
  },
  regional: {
    all_tv: { ppv: 0, tv: 12, none: 0, weight: 3 },
    grassroots: { ppv: 0, tv: 6, none: 5, weight: 1 },
  },
  local: {
    all_tv: { ppv: 0, tv: 10, none: 0, weight: 1 },
    grassroots: { ppv: 0, tv: 0, none: 8, weight: 3 },
  },
};

const GOALS_BY_TIER: Record<Tier, Goal[]> = {
  global: ["prestige", "profit", "growth"],
  major: ["prestige", "profit", "growth", "development"],
  regional: ["profit", "growth", "development"],
  local: ["profit", "development", "development"],
};

/** TV partners an AI promotion of this size can land, by network id (see business.NETWORKS). */
export const AI_TV_NETWORKS: Record<Tier, number[]> = { global: [1, 2], major: [2, 3], regional: [3, 4], local: [4] };
export const AI_PPV_NETWORKS = [5, 6];
/** Local cable for small shows that aren't on a national network. */
export const LOCAL_TV_REACH = 10;

export interface PromotionPlan { flavor: Flavor; goal: Goal; tvNetworkId: number | null; ppvNetworkId: number | null }

/** A promotion's flavor, goal and partners, seeded by its id. */
export function pickPlan(id: number, tier: Tier): PromotionPlan {
  const options = Object.entries(PLANS[tier]) as [Flavor, { weight: number }][];
  const total = options.reduce((s, [, o]) => s + o.weight, 0);
  let roll = hash(id, "flavor") % total, flavor = options[0]![0];
  for (const [f, o] of options) { if (roll < o.weight) { flavor = f; break; } roll -= o.weight; }
  const goals = GOALS_BY_TIER[tier];
  const goal = goals[hash(id, "goal") % goals.length]!;
  const tvs = AI_TV_NETWORKS[tier];
  const onTv = flavor !== "own_network" && !(flavor === "grassroots" && tier === "local");
  // Local TV for a local all-TV show is cable, not a network.
  const tvNetworkId = onTv && !(tier === "local") ? tvs[hash(id, "tv") % tvs.length]! : null;
  const ppvNetworkId = PLANS[tier][flavor]!.ppv > 0 ? AI_PPV_NETWORKS[hash(id, "ppv") % AI_PPV_NETWORKS.length]! : null;
  return { flavor, goal, tvNetworkId, ppvNetworkId };
}

/**
 * The year's cards: PPVs spaced evenly, TV cards in the weeks between, then
 * untelevised shows. `money` scales the count: a promotion in the red cuts
 * back, a rich one chasing growth adds cards.
 */
export function buildSchedule(id: number, tier: Tier, flavor: Flavor, goal: Goal, money: "broke" | "tight" | "ok" | "rich", year: number): Map<number, CardKind> {
  const plan = PLANS[tier][flavor] ?? Object.values(PLANS[tier])[0]!;
  let scale = goal === "growth" ? 1.12 : goal === "profit" ? 0.88 : 1;
  if (money === "broke") scale *= 0.6;
  else if (money === "tight") scale *= 0.85;
  else if (money === "rich" && goal === "growth") scale *= 1.1;
  const ppv = Math.round(plan.ppv * Math.min(1, scale));
  const tv = Math.round(plan.tv * scale);
  const none = Math.round(plan.none * scale);
  const total = Math.min(WEEKS_PER_YEAR - 2, Math.max(money === "broke" ? 3 : 4, ppv + tv + none));
  const out = new Map<number, CardKind>();
  const offset = hash(id, `sched${year}`) % WEEKS_PER_YEAR;
  const free = (w: number) => { for (let d = 0; d < WEEKS_PER_YEAR; d++) { const x = (w + d) % WEEKS_PER_YEAR; if (x !== 0 && !out.has(x)) return x; } return -1; };
  for (let i = 0; i < ppv; i++) out.set(free(offset + Math.floor((i * WEEKS_PER_YEAR) / ppv) + 3), "ppv");
  const rest = total - out.size;
  const tvShare = tv + none === 0 ? 0 : tv / (tv + none);
  for (let i = 0; i < rest; i++) {
    const w = free(offset + Math.floor((i * WEEKS_PER_YEAR) / rest));
    if (w < 0) break;
    out.set(w, i < Math.round(rest * tvShare) ? "tv" : "none");
  }
  // Interleave TV and untelevised weeks rather than bunching them.
  if (tv > 0 && none > 0) {
    const weeks = [...out].filter(([, k]) => k !== "ppv").map(([w]) => w).sort((a, b) => a - b);
    const nTv = weeks.filter((w) => out.get(w) === "tv").length;
    weeks.forEach((w, i) => out.set(w, Math.floor(((i + 1) * nTv) / weeks.length) > Math.floor((i * nTv) / weeks.length) ? "tv" : "none"));
  }
  return out;
}

export const encodeSchedule = (s: Map<number, CardKind>) => [...s].sort((a, b) => a[0] - b[0]).map(([w, k]) => `${w}:${k}`).join(",");
export function decodeSchedule(text: string | null, tier: Tier): Map<number, CardKind> {
  const out = new Map<number, CardKind>();
  for (const part of (text ?? "").split(",").filter(Boolean)) {
    const [w, k] = part.split(":");
    out.set(Number(w), (k as CardKind | undefined) ?? (tier === "local" ? "none" : "tv"));
  }
  return out;
}

/** Short brand for card names: "Frontier Fighting Championship" -> "FFC". */
export function shortName(p: PromotionState): string {
  const words = p.name.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
  return words.length >= 2 ? words.map((w) => w[0]).join("") : p.name;
}

export function cardName(p: PromotionState, kind: CardKind, n: { ppv: number; tv: number; all: number }, flavor: Flavor): string {
  const s = shortName(p);
  if (kind === "ppv") return `${s} ${n.ppv}`;
  if (kind === "tv") return flavor === "own_network" ? `${s} Live ${n.tv}` : flavor === "ppv_led" || flavor === "hybrid" ? `${s} Fight Night ${n.tv}` : `${s} ${n.all}`;
  return `${p.name} ${n.all}`;
}

/** Bouts per card: PPVs are the deepest, side TV cards a little lighter. */
export function boutsFor(kind: CardKind, tier: Tier, base: number): number {
  if (kind === "ppv") return base + 1;
  if (kind === "tv" && (tier === "global" || tier === "major")) return base - 1;
  return base;
}
