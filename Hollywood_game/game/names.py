"""Procedural name / title generation pools (era flavoured)."""
from __future__ import annotations

MALE = [
    "James", "Clark", "Humphrey", "Cary", "Spencer", "Marlon", "Paul", "Rod",
    "Harrison", "Denzel", "Morgan", "Gene", "Fred", "Burt", "Steve", "Jack",
    "Al", "Peter", "Warren", "Robert", "Anthony", "Gregory", "William", "Tyrone",
    "Joel", "Victor", "Lionel", "Edward", "Melvyn", "Randolph", "Gary", "John",
    "Henry", "Van", "Sterling", "Chad", "Douglas", "Errol", "Caryll", "Rex",
    "Michael", "Tom", "Arnold", "Sylvester", "Bruce", "Keanu", "Leonardo",
    "Johnny", "Matt", "George", "Brad", "Christian", "Hugh", "Ryan", "Oscar",
    "Timothé", "Adrien", "Ralph", "Javier", "Idris", "Dev", "Pedro", "Austin",
]
FEMALE = [
    "Greta", "Marlene", "Vivien", "Ingrid", "Audrey", "Marilyn", "Grace",
    "Katharine", "Bette", "Joan", "Rita", "Lana", "Ava", "Elizabeth", "Natalie",
    "Jane", "Sophia", "Brigitte", "Shirley", "Doris", "Mae", "Jean", "Barbra",
    "Liza", "Faye", "Goldie", "Meryl", "Jessica", "Glenn", "Frances", "Julia",
    "Nicole", "Cate", "Charlize", "Rachel", "Saoirse", "Anya", "Florence",
    "Zendaya", "Lupita", "Viola", "Octavia", "Tilda", "Isabelle", "Anouk",
    "Cecile", "Delphine", "Rosa", "Ines", "Yuki", "Priya", "Aisha", "Noor",
]
SURNAMES = [
    "Tracey", "Marlowe", "Sterling", "Calloway", "Ashwood", "Vance", "Halloway",
    "Beaumont", "Kastellan", "Delacroix", "Wexler", "Ravenswood", "Cruz", "Moreau",
    "Lancaster", "Ferro", "Okafor", "Vidal", "Sinatra", "Borgnine", "Previn",
    "Winters", "Hallow", "Crane", "Hutton", "Lorre", "Colman", "Garson", "Traverse",
    "Fairbanks", "Huston", "Fonda", "Grant", "Hepburn", "Kelly", "Minelli",
    "Newman", "Neville", "Quaid", "Reynolds", "Scott", "Thorne", "Ullman",
    "Valdez", "Whitlock", "Yeager", "Zellweger", "Ambrose", "Brockway", "Corda",
    "Draper", "Eastwood", "Frost", "Gable", "Hawkes", "Irving", "Jonze", "Kovic",
    "Lambert", "Mercer", "Nash", "Otis", "Perry", "Quint", "Rourke", "Salois",
    "Tennant", "Updike", "Voss", "Walsh", "Yarbrough", "Zannuck", "Ferro",
    "Marchetti", "Nakamura", "Petrov", "Duarte", "Halloran", "Bergman", "Rossellini",
]
NAME_SUFFIX = ["Jr.", "Sr.", "II", "III", "", "", "", "", "", ""]

# Studio name flavour
STUDIO_WORDS_A = ["Gold", "Silver", "Crimson", "Pacific", "Paramount", "Monarch",
                  "RKO", "Continental", "Majestic", "Coronet", "Vanguard",
                  "Liberty", "Sunset", "Babylon", "Titan", "Olympic", "Nebula",
                  "Sable", "Ivory", "Copper", "Northern", "Azure", "Halcyon"]
STUDIO_WORDS_B = ["Picture", "Feature", "Screen", "Celluloid", "Motion",
                  "Silver Screen", "Dream", "Starlight", "Reel", "Projector",
                  "Backlot", "Camera", "Lot", "Broadcast", "Cinéma"]
STUDIO_WORDS_C = ["Com", "Corp.", "Productions", "Studios", "Pictures", "Entertainment", "Media"]

# Movie title generation
T_TITLE_NOUN = [
    "Midnight", "Empire", "Thunder", "Velvet", "Canyon", "Neon", "Ivory",
    "Iron", "Crimson", "Shadow", "Paradise", "Vengeance", "Silent", "Golden",
    "Electric", "Broken", "Endless", "Savage", "Lonely", "Burning", "Frozen",
    "Hidden", "Last", "First", "Wild", "Quiet", "Bright", "Distant", "Hollow",
]
T_TITLE_NOUN2 = [
    "Train", "City", "Heart", "Knight", "Sirens", "Horizon", "Requiem",
    "Kingdom", "Gamblers", "Protocol", "Alibi", "Frontier", "Express", "Sonata",
    "Syndicate", "Orchid", "Valkyrie", "Machine", "Mirage", "Odyssey", "Garden",
    "Wolf", "Circus", "Cathedral", "Empress", "Detective", "Planet", "Rodeo",
    "Heist", "Rebel", "Saints", "Prophet", "Carnival", "Signal", "Archive",
]
T_TITLE_OF = ["of Shadows", "of Glass", "of the Damned", "in Revolt", "at Dawn",
              "in Mono", "of Dreams", "of Rust", "Rising", "Reloaded",
              "Reborn", "Unbound", "Part Two", "Never Ends", "Strike Back",
              "Legacy", "Origins", "Zero Hour", "Redux", "Final Cut"]

SERIES_SUFFIX = ["", " II", " III", " IV", " V", ": Reloaded", ": Legacy",
                 ": Origins", ": Uprising", ": Requiem", ": Legacy of Ash",
                 " Returns", ": Final Chapter", ": Resurrection"]


def person_name(rnd, gender: str) -> str:
    first = rnd.choice(MALE if gender == "m" else FEMALE)
    last = rnd.choice(SURNAMES)
    suf = rnd.choice(NAME_SUFFIX)
    if rnd.random() < 0.08:  # double barrelled stage name
        last = f"{last}-{rnd.choice(SURNAMES)}"
    return f"{first} {last}{(' ' + suf) if suf else ''}"


def stage_name(rnd, gender: str) -> str:
    """Shorter, punchier name for people who 'rebrand'."""
    first = rnd.choice(MALE if gender == "m" else FEMALE)
    last = rnd.choice(SURNAMES)
    return f"{first.split()[0][:rnd.choice([1, 2, 3])]}. {last}"


# --------------------------------------------------------------------------- #
#  The title bag
#
#  Titles are drawn like balls from a bag: the pieces below combine into far
#  more titles than a century of pictures can use, and every title the world
#  has used (yours, the rivals', the indies', the script market's) stays out
#  of the bag for good, so no two pictures share a name.
# --------------------------------------------------------------------------- #
ADJ = T_TITLE_NOUN + [
    "Scarlet", "Amber", "Velvet", "Hard", "Cold", "Blue", "Black", "White", "Gilded", "Rusted",
    "Painted", "Restless", "Reckless", "Fearless", "Faithless", "Nameless", "Lawless", "Sleepless",
    "Merciless", "Heartless", "Forgotten", "Forbidden", "Stolen", "Borrowed", "Crooked", "Narrow",
    "Wicked", "Gentle", "Tender", "Bitter", "Sweet", "Sudden", "Long", "Little", "Lucky",
    "Mad", "Dangerous", "Beautiful", "Sinful", "Holy", "Secret", "Private", "Public", "Perfect",
    "Lost", "Final", "Second", "Twelfth", "Seventh", "Southern", "Northern", "Western", "Eastern",
    "High", "Low", "Deep", "Dark", "Pale", "Silver", "Iron", "Paper", "Glass", "Stone", "Copper",
    "Brass", "Marble", "Crystal", "Silk", "Satin", "Smoke", "Ash", "Salt", "Sugar", "Honey",
    "Thunder", "Desert", "Ocean", "River", "Harbor", "Mountain", "Prairie", "Jungle", "Winter",
    "Summer", "Autumn", "Spring", "Morning", "Evening", "Twilight", "Starlit", "Moonlit", "Sunlit",
    "Rainy", "Dusty", "Hungry", "Thirsty", "Lonesome", "Wandering", "Fallen", "Rising", "Dying",
    "Living", "Dancing", "Singing", "Laughing", "Weeping", "Burning", "Drowning", "Sleeping",
    "Waking", "Running", "Falling", "Flying", "Shining", "Haunted", "Hunted", "Wanted", "Kept",
]
NOUN = T_TITLE_NOUN2 + [
    "Affair", "Alley", "Angel", "Avenue", "Bargain", "Bayou", "Bell", "Bride", "Bridge", "Canary",
    "Captive", "Castle", "Champion", "Chase", "Coast", "Code", "Compass", "Confession", "Corner",
    "Country", "Courage", "Crossing", "Crown", "Curtain", "Daughter", "Dawn", "Debt", "Deception",
    "Diamond", "Doorway", "Dragon", "Drifter", "Dynasty", "Eclipse", "Echo", "Embrace", "Exile",
    "Fever", "Fire", "Flame", "Flood", "Fortune", "Fugitive", "Gambit", "Gate", "Ghost", "Gold",
    "Grace", "Gunfighter", "Harvest", "Hawk", "Highway", "Hour", "Hunter", "Hurricane", "Island",
    "Jewel", "Journey", "Jury", "Key", "Kiss", "Lady", "Lantern", "Legend", "Letter", "Lie",
    "Lighthouse", "Lover", "Lullaby", "Mansion", "Marauder", "Masquerade", "Melody", "Mercy",
    "Midnight", "Mission", "Monsoon", "Moon", "Morning", "Mountain", "Mystery", "Night", "Nocturne",
    "Oath", "Outlaw", "Pact", "Palace", "Paradox", "Partner", "Passage", "Passenger", "Pearl",
    "Pilgrim", "Pistol", "Promise", "Puzzle", "Queen", "Ransom", "Reckoning", "Refuge", "Rhapsody",
    "Riddle", "River", "Road", "Romance", "Rose", "Ruin", "Sanctuary", "Scandal", "Secret",
    "Serenade", "Shore", "Silence", "Sinner", "Sister", "Skyline", "Smile", "Soldier", "Son",
    "Spark", "Spy", "Star", "Storm", "Stranger", "Street", "Summer", "Sundown", "Swan", "Tango",
    "Tempest", "Thief", "Tide", "Tower", "Trail", "Traitor", "Treasure", "Truth", "Tunnel",
    "Twins", "Valley", "Vendetta", "Verdict", "Voyage", "Waltz", "Wanderer", "Warning", "Widow",
    "Wilderness", "Wind", "Window", "Wings", "Winter", "Witness", "Woman", "Yesterday",
]
TAIL = T_TITLE_OF + [
    "of the North", "of the Lost", "at Midnight", "in the Rain", "on the Run", "on Fire",
    "in Paradise", "of Fortune", "of Desire", "of the Deep", "of the Sun", "of the Moon",
    "in Winter", "at Sea", "on Trial", "of Ashes", "of Gold", "of Silence", "Strikes Back",
    "Returns", "Forever", "for Hire", "for Sale", "in Love", "in Danger", "Undercover",
    "of the Ages", "of Tomorrow", "at the Edge", "Beneath", "Below", "Above", "Abroad",
    "of the Plains", "of the River", "in the Dark", "after Dark", "on the Wire",
]
PLACES = ["Tangier", "Havana", "Shanghai", "Marrakesh", "Monte Carlo", "Casablanca", "Lisbon",
          "Cairo", "Rio", "Vienna", "Budapest", "Istanbul", "Bombay", "Singapore", "Macao",
          "Santa Fe", "Laredo", "Tucson", "Abilene", "Dodge", "Tombstone", "El Paso", "Yuma",
          "Brooklyn", "Harlem", "Chinatown", "Malibu", "Sunset Strip", "Bourbon Street", "the Bowery",
          "Coney Island", "Atlantic City", "Reno", "Vegas", "Miami", "Key West", "New Orleans",
          "Alaska", "the Yukon", "the Congo", "Zanzibar", "Bali", "Tahiti", "Capri", "Venice",
          "Naples", "Paris", "Berlin", "London", "Soho", "Dublin", "Glasgow", "Mars", "Venus",
          "the Moon", "Saturn", "Orion", "Andromeda", "Station Nine", "Sector Seven"]
NAMES = ["Molly", "Johnny", "Rosie", "Billy", "Lola", "Frankie", "Sadie", "Charlie", "Mabel",
         "Danny", "Ruby", "Eddie", "Stella", "Jimmy", "Daisy", "Lucky", "Nora", "Max", "Gilda",
         "Annie", "Rocco", "Vera", "Sonny", "Ginger", "Duke", "Hazel", "Benny", "Iris", "Mickey",
         "Pearl", "Slim", "Dolores", "Hank", "Trixie", "Louie", "Opal", "Sal", "Lulu", "Gus"]
SINGLES = ["Undertow", "Crossfire", "Nightfall", "Firebrand", "Heatwave", "Afterglow", "Sidewinder",
           "Moonstruck", "Daybreak", "Riptide", "Backfire", "Overdrive", "Sunburn", "Snowblind",
           "Windfall", "Wildfire", "Downpour", "Blackout", "Breakaway", "Hideaway", "Showdown",
           "Payday", "Longshot", "Deadline", "Dragnet", "Firewall", "Lockdown", "Outpost",
           "Stardust", "Quicksilver", "Brimstone", "Hellbound", "Homecoming", "Free Fall",
           "Checkmate", "Masquerade", "Jubilee", "Stampede", "Hurricane", "Avalanche", "Vertigo",
           "Mirage", "Paradox", "Labyrinth", "Monolith", "Exodus", "Aftermath", "Undercurrent"]
PHRASES = ["Before the {n}", "After the {n}", "Beyond the {n}", "Under a {a} {n}", "Last {n} to {p}",
           "Return to {p}", "Escape from {p}", "Night in {p}", "A {n} in {p}", "Nobody's {n}",
           "Somebody's {n}", "{x}'s {n}", "A {n} for {x}", "{x} of {p}", "The {n} from {p}",
           "The {a} {n}", "The {n} and the {n2}", "{n} and {n2}", "Every {n} Has a {n2}",
           "No {n} for {x}", "Where the {n} Ends", "When the {n} Falls", "The Last {n}",
           "The {n} Next Door", "Goodbye, {x}", "Hello, {p}", "Meet Me in {p}", "Trouble in {p}",
           "Danger on {p}", "{a} {n} over {p}", "The {n} of {p}", "Kiss the {n}", "Shoot the {n}",
           "Bury the {n}", "Follow the {n}", "Chase the {n}", "Count the {n}s", "Watch the {n}"]
GENRE_FLAVOR = {
    "western": (["Dusty", "Lone", "Six-Gun", "Prairie", "Outlaw", "Badlands", "Saddle", "Iron"],
                ["Rider", "Stallion", "Posse", "Sheriff", "Mesa", "Ranch", "Gulch", "Stagecoach", "Frontier"]),
    "horror": (["Bloody", "Dead", "Unholy", "Cursed", "Rotten", "Screaming", "Grave"],
               ["Crypt", "Coffin", "Phantom", "Asylum", "Curse", "Beast", "Shadow", "Ghoul", "Ritual"]),
    "sci-fi": (["Atomic", "Galactic", "Orbital", "Synthetic", "Quantum", "Solar", "Lunar", "Electric"],
               ["Android", "Colony", "Comet", "Nebula", "Starship", "Signal", "Outpost", "Robot", "Planet"]),
    "musical": (["Swinging", "Dancing", "Singing", "Jazz", "Starry", "Broadway"],
                ["Melody", "Rhythm", "Serenade", "Revue", "Follies", "Ballroom", "Chorus", "Songbird"]),
    "comedy": (["Silly", "Crazy", "Nutty", "Lucky", "Funny", "Daffy", "Merry"],
               ["Business", "Weekend", "Wedding", "Honeymoon", "Mix-Up", "Caper", "Bachelor", "Fiasco"]),
    "crime": (["Dirty", "Crooked", "Hot", "Killer", "Fast", "Rough", "Naked"],
              ["Heist", "Racket", "Mob", "Getaway", "Precinct", "Score", "Frame-Up", "Squad", "Hit"]),
    "romance": (["Tender", "Sweet", "Secret", "Summer", "Moonlit", "Endless"],
                ["Kiss", "Heart", "Affair", "Promise", "Valentine", "Bride", "Darling", "Sweetheart"]),
    "action": (["Maximum", "Total", "Raw", "Deadly", "Hard", "Steel", "Rapid"],
               ["Impact", "Strike", "Fury", "Commando", "Assault", "Pursuit", "Target", "Vendetta"]),
    "drama": (["Quiet", "Distant", "Broken", "Silent", "Bitter", "Honest", "Fragile"],
              ["Inheritance", "Season", "Daughter", "Confession", "Homecoming", "Testament", "Harvest"]),
    "animation": (["Magic", "Little", "Wonderful", "Merry", "Tiny", "Brave", "Enchanted"],
                  ["Kingdom", "Forest", "Mouse", "Dragon", "Toybox", "Princess", "Adventure", "Island"]),
}

_TITLE_DB = None
_USED: set | None = None


def bind_titles(db):
    """The bag belongs to one world: load every title it has already used."""
    global _TITLE_DB, _USED
    _TITLE_DB = db
    _USED = set()
    try:
        for sql in ("SELECT title FROM title_bag", "SELECT title FROM movies",
                    "SELECT title FROM rival_releases", "SELECT title FROM scripts",
                    "SELECT title FROM box_runs"):
            for r in db.q(sql):
                _USED.add((r[0] or "").lower())
    except Exception:
        pass


def _compose(rnd, genre=None) -> str:
    adj, noun = ADJ, NOUN
    fl = GENRE_FLAVOR.get(genre) if genre else None
    if fl and rnd.random() < 0.45:
        adj, noun = fl
    r = rnd.random()
    if r < 0.30:
        return f"{rnd.choice(adj)} {rnd.choice(noun)}"
    if r < 0.42:
        return f"{rnd.choice(adj)} {rnd.choice(noun)} {rnd.choice(TAIL)}"
    if r < 0.50:
        return f"The {rnd.choice(noun)}"
    if r < 0.58:
        return f"{rnd.choice(noun)} {rnd.choice(TAIL)}"
    if r < 0.64:
        return rnd.choice(SINGLES)
    if r < 0.67:
        return f"{rnd.choice(noun)}!"
    tpl = rnd.choice(PHRASES)
    n, n2 = rnd.choice(noun), rnd.choice(NOUN)
    while n2 == n:
        n2 = rnd.choice(NOUN)
    return tpl.format(n=n, n2=n2, a=rnd.choice(adj), p=rnd.choice(PLACES), x=rnd.choice(NAMES))


def movie_title(rnd, genre=None) -> str:
    """Draw a title from the bag: never one the world has already used."""
    t = _compose(rnd, genre)
    if _USED is None:
        return t
    tries = 0
    while t.lower() in _USED and tries < 60:
        t = _compose(rnd, genre)
        tries += 1
    if t.lower() in _USED:                    # the bag ran dry for this shape
        t = f"{t} ({rnd.choice(['Redux', 'Again', 'Anew', 'Encore', 'Reprise'])})"
        n = 2
        while t.lower() in _USED:
            t = f"{t.split(' (')[0]} ({n})"
            n += 1
    take(t)
    return t


REBOOT_SUFFIX = [": Begins", ": Reborn", ": Rising", ": Year One", ": Origins", ": The Beginning",
                 ": First Blood", ": Genesis", ": Awakening", ": New Blood", ": Legacy", ": Reckoning"]
REBOOT_PREFIX = ["The New", "The Amazing", "The True", "The Real", "The Untold", "Young"]


def reboot_title(base: str, rnd) -> str:
    """A reboot keeps the name on the poster but never repeats a title."""
    if not is_used(base):
        return base
    for _ in range(30):
        if rnd.random() < 0.65:
            t = base + rnd.choice(REBOOT_SUFFIX)
        else:
            b = base[4:] if base.startswith("The ") else base
            t = f"{rnd.choice(REBOOT_PREFIX)} {b}"
        if not is_used(t):
            return t
    n = 2
    while is_used(f"{base} ({n})"):
        n += 1
    return f"{base} ({n})"


def unique_sequel(base: str, index: int, rnd) -> str:
    """A numbered or subtitled sequel title nobody has used."""
    for _ in range(20):
        t = series_title(base, index, rnd)
        if not is_used(t):
            return t
    return f"{base} {index}" if not is_used(f"{base} {index}") else f"{base} {index} ({rnd.randint(2, 99)})"


def take(title: str):
    """Mark a title as used (any title, however it was made)."""
    if _USED is None or not title:
        return
    k = title.lower()
    if k in _USED:
        return
    _USED.add(k)
    if _TITLE_DB is not None:
        try:
            _TITLE_DB.execute("INSERT OR IGNORE INTO title_bag(title) VALUES(?)", (title,))
        except Exception:
            pass


def is_used(title: str) -> bool:
    return bool(_USED) and (title or "").lower() in _USED


def studio_name(rnd) -> str:
    return f"{rnd.choice(STUDIO_WORDS_A)} {rnd.choice(STUDIO_WORDS_B)} {rnd.choice(STUDIO_WORDS_C)}"


def series_title(base: str, index: int, rnd) -> str:
    """Sequel/reboot titling. Reboots drop the numbering entirely."""
    if index <= 1:
        return base
    if rnd.random() < 0.55:
        # numbered sequels must carry the right number; the flavour suffixes
        # ("Returns", "Reloaded"...) can go on any installment
        roman = ["", "", " II", " III", " IV", " V", " VI", " VII", " VIII", " IX", " X"]
        num = roman[index] if index < len(roman) else f" {index}"
        flavour = [x for x in SERIES_SUFFIX if x.startswith(":") or x.startswith(" R")]
        return base + (num if rnd.random() < 0.6 else rnd.choice(flavour))
    # "subtitled" sequel
    return f"{base}: {rnd.choice(T_TITLE_NOUN)} {rnd.choice(T_TITLE_NOUN2)}"
