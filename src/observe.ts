// The describer. It turns a photograph into a written record of what is physically in the frame,
// and it is not allowed to say where that is. Jev does the geography.
//
// The ban is not a polite request in a prompt. Every field except the copied sign text is checked
// against the country list, its adjectives, and the obvious giveaway words, and a violation throws.
// That is what makes the result mean anything: if the describer could say "Brazil", it would be the
// one doing the guessing.

import { generateObject } from "ai";
import { z } from "zod";
import { COUNTRIES } from "./countries.ts";

export const DESCRIBER_MODEL = "google/gemini-3.5-flash";

export const ObservationSchema = z.object({
  sign_text_verbatim: z.array(z.string()).describe(
    "Every piece of writing legible in the frame, copied character for character in its original script. Empty if nothing is readable."),
  driving_side: z.enum(["left", "right", "unclear"]).describe(
    "Which side of the road traffic is on, judged from parked cars, moving cars, and the position of the camera vehicle."),
  road_surface_and_markings: z.string().describe(
    "Surface material and condition, and the colour, pattern and placement of every painted line."),
  license_plates: z.string().describe(
    "Shape, proportions, background colour, character colour, and any coloured strip or band. Say 'not legible' if they are not."),
  poles_bollards_barriers: z.string().describe(
    "Utility poles, streetlights, bollards, guardrails, kerbs: material, shape, colour, painted bands, and how wires are strung."),
  architecture: z.string().describe(
    "Building height, materials, roof shape and pitch, window and balcony style, shopfront style."),
  vegetation: z.string().describe(
    "Plant types by physical appearance: leaf shape, trunk form, height, density, colour, ground cover."),
  terrain_and_soil: z.string().describe(
    "Landform, slope, and the colour and texture of any exposed earth or rock."),
  sky_and_light: z.string().describe(
    "Cloud, haze, apparent sun height, shadow direction and hardness, season as read from the plants."),
  vehicles: z.string().describe(
    "Body styles, sizes, ages and colours of vehicles, and which side the steering wheel is on if visible."),
  other_details: z.string().describe(
    "Anything else physically present: street furniture, antennas, wires, fences, litter bins, road signs by shape and colour only."),
});

export type Observation = z.infer<typeof ObservationSchema>;

const INSTRUCTIONS = `You are recording what is physically visible in one street level photograph, for someone who will never see it.

Describe only what is in the frame. Be concrete and specific about shapes, materials, colours and proportions.

You must not state or hint at where the photograph was taken. Do not name, and do not allude to:
- any country, territory, state, province, county, region, city, town or road
- any nationality or demonym
- any language, alphabet or writing system by name
- any currency, company, brand or institution
- any continent, hemisphere, or direction of travel from anywhere

Copy legible writing into sign_text_verbatim exactly as it appears, character for character, in its original script. Do not translate it, do not transliterate it, and do not say what language it is. Copying the characters is recording the frame. Naming the language is not.

Do not say that anything is iconic, famous, recognisable, a landmark, typical, traditional, or characteristic. If a structure is distinctive, give its shape, height, material and proportions and let those stand on their own.

Everywhere else, write as though you do not know that places have names.`;

// Regions, continents, language families and writing systems. Country names, capitals and demonyms
// come from the generated data instead, as whole phrases: "Marshall Islands" is banned, "islands" is
// not, because a describer has every right to say it can see islands.
const EXTRA_BANNED = [
  "europe", "european", "asia", "asian", "africa", "african", "america", "american", "americas",
  "oceania", "antarctica", "scandinavia", "scandinavian", "nordic", "baltic", "balkan", "balkans",
  "iberia", "iberian", "mediterranean", "caribbean", "levant", "maghreb", "sahel", "patagonia",
  "latin", "hispanic", "anglo", "slavic", "arab", "arabic", "cyrillic", "roman alphabet",
  "kanji", "kana", "hiragana", "katakana", "hangul", "devanagari", "cyrillic script", "arabic script",
  "oriental", "occidental", "subcontinent", "commonwealth", "soviet", "ussr",
  "english", "spanish", "french", "german", "portuguese", "russian", "chinese", "japanese", "korean",
  "italian", "dutch", "polish", "turkish", "greek", "hebrew", "hindi", "urdu", "vietnamese", "thai",
  "swahili", "afrikaans", "mandarin", "cantonese", "farsi", "persian", "bengali", "tamil",
];

// The alias list is in every language, which drags in one ordinary English noun: "Island" is what
// Iceland is called in German and Danish. A describer that can see an island has to be able to say
// so. Every other collision on the list ("China", "Turkey", "Georgia", "Chad") is the English name
// of the country, and stays banned.
const NOT_A_PLACE_IN_ENGLISH = new Set(["island"]);

// Whole phrases, longest first, so "south africa" is tested before "africa".
const BANNED = [...new Set([
  ...COUNTRIES.flatMap((c) => c.aliases).map((a) => a.toLowerCase()),
  ...EXTRA_BANNED,
])]
  .map((term) => term.replace(/[^a-z0-9]+/g, " ").trim())
  .filter((term) => term.length >= 4 && !NOT_A_PLACE_IN_ENGLISH.has(term))
  .sort((a, b) => b.length - a.length);

// A describer can point without naming. "A very tall, iconic metal lattice tower" names no place
// and passes the country check, but "iconic" is the describer telling you it recognised the thing.
// Describing the shape is recording the frame. Flagging it as famous is doing the guessing.
// Only words that claim recognition. "Characteristic of late summer" is a real observation about
// the light, so blanket-banning "characteristic of" threw away good records; the place check already
// catches the case where the thing being pointed at is a place.
const HINT_WORDS = [
  "iconic", "famous", "world famous", "renowned", "recognisable", "recognizable", "unmistakable",
  "instantly recognisable", "instantly recognizable", "landmark", "world renowned", "tourist",
];

export class PlaceLeakError extends Error {
  field: string;
  term: string;
  text: string;
  constructor(field: string, term: string, text: string, kind: "place" | "hint") {
    super(kind === "place"
      ? `Describer named a place: "${term}" in ${field}`
      : `Describer pointed instead of describing: "${term}" in ${field}`);
    this.field = field;
    this.term = term;
    this.text = text;
  }
}

const contains = (haystack: string, term: string) => haystack.includes(` ${term} `);

/** Throws if any field but the copied sign text names a place, a nationality, a language, or flags something as recognisable. */
export function assertPlaceBlind(observation: Observation): void {
  for (const [field, value] of Object.entries(observation)) {
    if (field === "sign_text_verbatim" || typeof value !== "string") continue;
    const haystack = ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    for (const term of BANNED) {
      if (contains(haystack, term)) throw new PlaceLeakError(field, term, value, "place");
    }
    for (const term of HINT_WORDS) {
      if (contains(haystack, term)) throw new PlaceLeakError(field, term, value, "hint");
    }
  }
}

/** True when the copied sign text itself hands over a place name, so the benchmark can split on it. */
export function signsNameAPlace(observation: Observation): boolean {
  const text = ` ${observation.sign_text_verbatim.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return BANNED.some((term) => text.includes(` ${term} `));
}

export async function observe(
  image: Uint8Array,
  mediaType = "image/jpeg",
): Promise<{ observation: Observation; inputTokens: number; outputTokens: number }> {
  const { object, usage } = await generateObject({
    model: DESCRIBER_MODEL,
    schema: ObservationSchema,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: INSTRUCTIONS },
        { type: "file", mediaType, data: { type: "data", data: image } },
      ],
    }],
    abortSignal: AbortSignal.timeout(90_000),
  });
  assertPlaceBlind(object);
  return { observation: object, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
}
