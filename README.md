<h1 align="center">Jev vs. the World</h1>

<p align="center"><b>A model that never writes a word, and never sees the photo, playing GeoGuessr.</b><br>
TypeSafe AI's Jev only picks from options. It is handed all 194 countries and a written record of
what is physically in the frame, and it picks one.</p>

## How it works

Jev cannot read an image and cannot produce a sentence. So the round is split in two, and the split
is the whole point.

1. **The record.** A vision model writes down what is physically visible: which side of the road
   traffic is on, the exact characters on any sign, the shape and colour of licence plates, the style
   of poles and bollards, roof pitch, leaf shape, soil colour, sun height. It is forbidden to name a
   country, a capital, a nationality, a language or a writing system, and forbidden to call anything
   iconic, famous or recognisable.
2. **The menu.** All 194 UN member states, every time. No shortlist, no region filter.
3. **Jev picks.** It sees the record and the menu, and returns a probability for every one of the
   194. Its top pick is the guess.
4. **The score.** Code measures the distance from the guessed country's centroid to where the photo
   was actually taken, on GeoGuessr's own curve. It never touches the guess.

## The describer is not allowed to guess

This only means anything if the describer is not quietly doing the work. So the ban is enforced in
code, not asked for in a prompt. Every field except the copied sign text is checked against every
country's common name, official name, native names, alternate spellings, demonyms and capital, plus
continents, languages and scripts. A violation throws the round away rather than scoring it.

Getting that check right took two goes. The first version split country names into words, so
`Marshall Islands` banned the word "islands" and a describer that could see an island was not allowed
to say so. The list is now matched as whole phrases, built from real name data, and covered by
[tests](src/observe.test.ts).

Copied sign text is the one exception. A sign that says `PARIS 12 km` is a legitimate thing to read
off a photograph, the way a person playing would. The benchmark tracks which rounds had one and
reports those separately, so the number is not quietly propped up by road signs.

## Results

<!-- RESULTS -->

## Running it

```
npm install
cp .env.example .env     # one AI Gateway key covers both models
npm run sample -- --n=60 # builds data/testset.json from open imagery
npm run bench
```

Photos come from [KartaView](https://kartaview.org), which needs no API key and no billing, and
whose images can be redistributed. That is why the test set in `data/` is something you can rebuild
and check rather than take on trust.

`npm run guess -- <lat> <lng>` plays a single round anywhere there is coverage.

## Credits

Street level imagery from [KartaView](https://kartaview.org) (CC BY-SA). Country data from
[mledoze/countries](https://github.com/mledoze/countries) (MIT). Seed cities from
[lutangar/cities.json](https://github.com/lutangar/cities.json). Outlines from
[Natural Earth](https://www.naturalearthdata.com/). Ground truth from
[Nominatim](https://nominatim.openstreetmap.org/).
