<h1 align="center">Jev vs. the World</h1>

<p align="center"><b>A model that never writes a word, and never sees the photo, playing GeoGuessr.</b><br>
TypeSafe AI's Jev only picks from options. It is handed a written record of what is physically in
the frame, and a menu of places, and it picks one.</p>

## How it works

Jev cannot read an image and cannot produce a sentence. So a round is split in two, and the split
is the whole point.

1. **The record.** A vision model writes down what is physically visible: which side of the road
   traffic is on, the exact characters on any sign, the colour and banding of licence plates, the
   cross section of utility poles, the reflector pattern on guide posts, roof pitch, leaf shape,
   soil colour, the direction the shadows fall. It is forbidden to name a country, a capital, a
   nationality, a language or a writing system, and forbidden to call anything iconic or famous.
2. **The menu.** Regions of the world, and then regions inside those, and then towns.
3. **Jev picks.** It scores every option and returns a probability for each. It never sees the photo.
4. **The score.** Code measures the distance from the pin to where the photo was actually taken, on
   GeoGuessr's own curve. It never touches the guess.

## Why the menu is regions and not countries

Countries are the wrong target twice over.

They are the wrong size. Guessing "France" correctly still leaves the pin at France's centroid,
which on this test set is a median of 153km from the photo. And they are the wrong shape: the land
on either side of a frontier looks the same, so the evidence in a photograph points at a region,
not at a sovereign state.

So the menu is cut from real settlements by a k-d tree, splitting each group at its median along
its longer side, which makes cells small where people are and large where they are not. That is
also where photographs are and are not. Nothing is hand drawn. The cells it produces make the point
themselves:

```
Barcelona, Zaragoza, Toulouse and nearby (Spain / France / Andorra; around 42.0N 0.6E)
Marseille, Turin, Genoa and nearby      (Italy / France / Spain;   around 43.7N 7.5E)
```

The menu nests, so a guess narrows from a region to a smaller region to a town. And the pin does not
have to land on the winning option: when the evidence really is ambiguous between two sides of a
border, the honest place for the pin is between them, and distance scoring pays for that. The mean
is taken over unit vectors, because longitudes either side of the antimeridian average to the wrong
side of the planet.

## The describer is not allowed to guess

This only means anything if the describer is not quietly doing the work. So the ban is enforced in
code, not asked for in a prompt. Every field except the copied sign text is checked against every
country's common name, official name, native names, alternate spellings, demonyms and capital, plus
continents, languages and scripts, and against words like "iconic" that claim recognition without
naming anything. A violation throws the round away rather than scoring it.

Getting that right took two goes. The first version split country names into words, so
`Marshall Islands` banned the word "islands" and a describer that could see an island was not
allowed to say so. It is now matched as whole phrases built from real name data, with exactly one
documented exception: `Island` is what Iceland is called in German and Danish, and an ordinary
English noun. There are [tests](src/observe.test.ts).

Copied sign text is the one exception to the ban. A sign reading `PARIS 12 km` is a legitimate thing
to read off a photograph, the way a person playing would. Runs report those rounds separately, so
the number is not quietly propped up by road signs.

## Measuring anything at all

Most of the work here is infrastructure, because without it a number is just a number.

- **Ground truth is offline.** It was a Nominatim call per photo, rate limited to one a second,
  which is what capped the test set at sixty photos in forty minutes. It is now point in polygon
  against Natural Earth borders, [audited](scripts/audit-truth.ts) against the service it replaced:
  60 of 60 agreement, and in an earlier pass it never returned a wrong country, only nulls on
  coastal towns whose seafront falls outside a generalised coastline.
- **Observations are cached**, keyed by the photo and by a hash of the model, instructions and
  schema that produced them. The describer is 99% of the cost of a round, so this is what makes
  experiments affordable. Keying on the describer matters: without it, editing the prompt would
  silently replay observations written by the old one.
- **Two splits.** `dev.json` is for tuning against. `test.json` is run once, at the end. A number
  quoted from a set that was tuned against is not a measurement.
- **Baselines.** Random guessing, always guessing the set's most common country, and the best single
  country chosen with hindsight, which on a distance-scored game is a high bar.
- **An [oracle](scripts/oracle.ts).** What each menu would score if Jev played perfectly. A menu has
  its own ceiling, and comparing against it says whether to work on the menu or on the judgement.
- **A [ceiling](scripts/ceiling.ts).** The same photos handed straight to the vision model, no ban
  and no Jev. The gap is what the hand-off costs.
- **Every prompt change is an [ablation](scripts/ablate-describer.ts)**, reported as a paired mean
  difference against its standard error.

The imagery has a limit worth stating rather than hiding: KartaView has photos in 75 of the 194
countries. Jev still picks from all of them; the truth can only ever be one of those 75.

## Results

`dev.json`: 160 photos across 61 countries, balanced so the menu is actually exercised, every photo
at least two kilometres from a frontier and verified downloadable.

**What each menu could score if Jev played perfectly.** Free, no API calls, all 160 photos. This is
the ceiling, and it is the argument for not guessing countries:

| menu, played perfectly | mean points | median km | within 100km | within 25km |
|---|---:|---:|---:|---:|
| Right country, pin on its centroid | 4212 | 153 | 38% | 14% |
| Cells, 1 stage | 3986 | 252 | 13% | 4% |
| Cells, 2 stages | 4727 | 26 | 80% | 48% |
| Cells, 3 stages | 4751 | 12 | 83% | 59% |
| Nearest settlement on the list | 4960 | 4 | 99% | 85% |

Getting the country right still leaves a median of 153km on the table. The nested menu does not.

**What it actually scores.** 23 photos, not 160: the run hit a spend limit on the API key partway
through and the rest are not measured yet. Treat these as provisional.

| strategy | mean points | median km | within 100km | right country |
|---|---:|---:|---:|---:|
| country, top pick | 2582 | 669 | 26% | 52% |
| country, hedged across the distribution | 2596 | 1450 | 26% | 52% |
| cells, 1 stage | 2598 | 995 | 9% | 13% |
| cells, 2 stages | 3142 | 348 | 30% | 26% |
| cells, 3 stages | 3093 | 542 | 39% | 57% |
| **cells, 3 stages, top pick** | **3253** | **244** | **39%** | **61%** |
| cells, 3 stages, beam 3 | 2978 | 671 | 35% | 43% |
| _random country_ | 448 | | | 1% |
| _best single country, chosen with hindsight_ | 1922 | | | 0% |

Two things worth noting even at this sample size. Narrowing to a town cuts the median error from
669km to 244km. And the nested menu lands in the right country more often than the menu that was
actually asking about countries, 61% against 52%, which is the point: the photograph says which
region it is, and the country falls out of that rather than the other way round.


## Running it

```
npm install
cp .env.example .env         # one AI Gateway key covers both models
npm run places               # settlements, for the menu
npm run borders              # country polygons, for ground truth
npm run coverage             # where KartaView actually has photos
npm run sample -- --n=160    # builds data/dev.json
npm run compare              # every strategy, side by side
npm run oracle               # ceilings, free, no API calls
npm test
```

`npm run guess -- <lat> <lng>` plays a single round anywhere there is coverage.

## Credits

Street level imagery from [KartaView](https://kartaview.org) (CC BY-SA). Country data from
[mledoze/countries](https://github.com/mledoze/countries) (MIT). Settlements from
[GeoNames](https://www.geonames.org/) (CC BY). Seed cities from
[lutangar/cities.json](https://github.com/lutangar/cities.json). Borders and outlines from
[Natural Earth](https://www.naturalearthdata.com/). Ground truth audited against
[Nominatim](https://nominatim.openstreetmap.org/).
