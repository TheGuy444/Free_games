import type { Rng } from "./rng.js";
import type { Sex } from "./constants.js";

/**
 * Procedural names. Each region has a "flavor" of syllables so names feel
 * regional without using any real fighter's name. Surnames are built from
 * syllables, giving effectively unlimited unique combinations.
 */
interface Flavor {
  male: string[];
  female: string[];
  surnameStart: string[];
  surnameMid: string[];
  surnameEnd: string[];
}

const FLAVORS: Record<string, Flavor> = {
  northern: {
    male: ["Dane", "Cole", "Jace", "Reid", "Brock", "Tate", "Owen", "Grant", "Luke", "Wade", "Rhett", "Silas", "Miles", "Dex", "Hank"],
    female: ["Kara", "Tess", "Brynn", "Jade", "Lena", "Rory", "Skye", "Mara", "Elle", "Wren", "Paige", "Nora"],
    surnameStart: ["Hal", "Brock", "Stan", "Mor", "Ash", "Cal", "Wex", "Thorn", "Red", "Gar", "Hol", "Pen"],
    surnameMid: ["", "", "ing", "er", "en", "ow"],
    surnameEnd: ["ford", "ton", "wick", "ley", "by", "dale", "mont", "son", "well", "field"],
  },
  southern: {
    male: ["Tiago", "Rafo", "Davi", "Caio", "Enzo", "Luan", "Iago", "Bruno", "Jairo", "Nilo", "Vitor", "Otto"],
    female: ["Bia", "Lara", "Iara", "Nina", "Clara", "Maya", "Luana", "Dalia", "Sol", "Vera"],
    surnameStart: ["Al", "Bar", "Cor", "Fon", "Mar", "Sal", "Tav", "Val", "Ro", "Fer", "Lu", "Pra"],
    surnameMid: ["", "ar", "en", "ei", "an", "ol"],
    surnameEnd: ["eira", "ado", "ino", "oso", "aes", "ana", "ida", "unes", "elo", "aro"],
  },
  eastern: {
    male: ["Arkan", "Timur", "Ruslo", "Ilyan", "Dovran", "Zaur", "Mirak", "Vadim", "Kazbek", "Oleg", "Ravil", "Askar"],
    female: ["Alsu", "Zarina", "Dina", "Milana", "Kira", "Yana", "Aida", "Lilia", "Sabina", "Ilva"],
    surnameStart: ["Bor", "Kaz", "Mag", "Ras", "Tag", "Zar", "Khab", "Ves", "Dol", "Gur", "Ism", "Nur"],
    surnameMid: ["", "a", "u", "i", "ab", "om"],
    surnameEnd: ["ov", "ev", "aev", "imov", "enko", "ulin", "agov", "anov", "ik", "ski"],
  },
  island: {
    male: ["Kaito", "Ren", "Daiki", "Haru", "Sota", "Ryo", "Yuto", "Shin", "Taku", "Kenji", "Isamu", "Jun"],
    female: ["Aiko", "Mei", "Rina", "Hana", "Sora", "Yui", "Emi", "Nao", "Kana", "Rei"],
    surnameStart: ["Ta", "Ka", "Mo", "Hi", "Na", "Su", "Fu", "Ya", "Ishi", "Ku", "O", "Sa"],
    surnameMid: ["ka", "ra", "mi", "shi", "ta", "no"],
    surnameEnd: ["da", "moto", "gawa", "mura", "saki", "hara", "yama", "zawa", "uchi", "ta"],
  },
  coastal: {
    male: ["Kwame", "Tunde", "Femi", "Jabari", "Kofi", "Sefu", "Zuri", "Ade", "Obi", "Musa", "Tariq", "Ayo"],
    female: ["Amara", "Zola", "Nia", "Ife", "Ayana", "Kesi", "Dayo", "Lulu", "Imani", "Tola"],
    surnameStart: ["Ade", "Oka", "Ban", "Eze", "Olu", "Mba", "Kun", "Nwa", "Asa", "Odu", "Ibe", "Ola"],
    surnameMid: ["", "o", "e", "an", "ub", "il"],
    surnameEnd: ["yemi", "for", "ke", "chukwu", "wale", "nde", "si", "ola", "mbe", "tunde"],
  },
  highland: {
    male: ["Mateo", "Diego", "Ivan", "Pablo", "Joaquin", "Emil", "Ruben", "Hugo", "Andres", "Marco", "Alvar", "Nico"],
    female: ["Elena", "Lucia", "Ines", "Sofia", "Carla", "Rocio", "Marta", "Alba", "Pilar", "Noa"],
    surnameStart: ["Gar", "Her", "Mon", "Ven", "Cas", "Esp", "Rui", "Ord", "Bel", "Quin", "Dom", "Ser"],
    surnameMid: ["", "an", "er", "ol", "ar", "in"],
    surnameEnd: ["ez", "ales", "ero", "illa", "ante", "ado", "eda", "on", "ijo", "uz"],
  },
};

export const FLAVOR_KEYS = Object.keys(FLAVORS);

export function makeName(rng: Rng, flavorKey: string, sex: Sex): { first: string; last: string } {
  const f = FLAVORS[flavorKey] ?? FLAVORS.northern!;
  const first = rng.pick(sex === "M" ? f.male : f.female);
  const last = rng.pick(f.surnameStart) + rng.pick(f.surnameMid) + rng.pick(f.surnameEnd);
  return { first, last };
}

const PROMO_PREFIX = ["Iron", "Apex", "Steel", "Titan", "Summit", "Vanguard", "Crown", "Rival", "Storm", "Granite", "Ember", "Frontier", "Atlas", "Onyx", "Cobalt", "Blackwater", "Redline", "Northstar", "Harbor", "Sovereign"];
const PROMO_SUFFIX = ["Fighting Championship", "Combat League", "Fight Series", "Cage Wars", "MMA", "Fight Alliance", "Combat Sports", "Battle Series", "Warrior Showcase", "Fight Night"];

export function makePromotionName(rng: Rng, used: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const n = `${rng.pick(PROMO_PREFIX)} ${rng.pick(PROMO_SUFFIX)}`;
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  const n = `${rng.pick(PROMO_PREFIX)} ${rng.pick(PROMO_SUFFIX)} ${used.size}`;
  used.add(n);
  return n;
}

/** Fictional regions. Each maps to a name flavor and amateur-sport strengths. */
export const REGION_DEFS = [
  { code: "NOR", name: "Norvale", flavor: "northern", strengths: ["WRES_FREE", "BOXING", "AM_MMA"] },
  { code: "SOL", name: "Solmara", flavor: "southern", strengths: ["BJJ", "MUAY_THAI", "AM_MMA"] },
  { code: "KAZ", name: "Kazhar Steppe", flavor: "eastern", strengths: ["SAMBO", "WRES_FREE", "JUDO"] },
  { code: "ISU", name: "Isuna Isles", flavor: "island", strengths: ["KARATE", "JUDO", "KICKBOXING"] },
  { code: "ODA", name: "Odara Coast", flavor: "coastal", strengths: ["BOXING", "KICKBOXING", "WRES_FREE"] },
  { code: "VAL", name: "Valcresta", flavor: "highland", strengths: ["BOXING", "TAEKWONDO", "BJJ"] },
  { code: "BRA", name: "Bravik", flavor: "eastern", strengths: ["WRES_GRECO", "SAMBO", "BOXING"] },
  { code: "TEM", name: "Temari Reach", flavor: "island", strengths: ["MUAY_THAI", "KARATE", "TAEKWONDO"] },
] as const;
