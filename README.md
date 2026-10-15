# Andar — Phase 1 phone prototype

*Andar*: Tagalog and Spanish for "to move, to keep going."

Andar tests one question: **do cues that warn you about turns and braking before they happen lower your car sickness?**

It runs in Chrome on your Android phone. On "cues on" rides it shows chevrons and vibrates about 2 seconds before each turn on your route (1, 2 or 3 for slight, normal or sharp), and moves a band of dots like passing scenery whenever the car brakes, speeds up or turns. On "cues off" rides it records the same data but shows nothing, so you have something to compare against. After enough rides it tells you whether the cues helped.

The decision logic lives in `src/engine.js` with no phone-specific code, so the same engine moves to the glasses in Phase 2.

## Using it

1. Open the app link in **Chrome on Android**. Tap ⋮ → **Add to Home screen** so it opens like an app.
2. First run: allow **location** when asked.
3. Try the **45-second demo drive** once to see and feel what cues look like.
4. Before each real ride: **Start a ride** → search the destination (or ride without one) → pick how the phone is mounted → **Start ride**, then keep the phone still for 2 seconds.
5. During the ride, answer the check-in every 2 minutes: 0 = not sick at all, 20 = about to vomit.
6. At the end, tap **End ride** twice and answer the three quick questions.

Keep the app open and the screen on during the ride. The app asks the phone to stay awake; if your screen still turns off, set the screen timeout to 10 minutes or more.

## The ride protocol

The app decides each ride's mode for you (cues on, off, off, on, repeating). Follow it even when you'd rather have cues; the off rides are what prove anything.

| Rule | Why |
|---|---|
| Passenger only. Never use it while driving. | Safety. |
| Rides of **10 minutes or longer**. Shorter rides are saved but not counted. | Sickness needs time to build. |
| At least **6 rides in each mode** (12 total). | Fewer rides can't separate a real effect from a good or bad day. |
| Keep conditions similar across modes: same seat when you can, similar roads, same activity. | So the only difference is the cues. |
| Don't change medication, Reliefband or other remedies mid-trial. If you use one, use it on every ride and note it. | Otherwise you're testing the remedy, not the cues. |
| Keep "Warn before a turn" at the same setting for the whole trial. | Changing it mid-trial mixes two experiments. |
| Rate honestly, even if a cues-on ride felt bad. | The verdict is only as good as the ratings. |

When you have 6+ usable rides in each mode, **Results** gives one of four verdicts: still collecting, cues helped, no benefit, or not clear yet (add 4 more rides each). "Cues helped" requires at least a 20% lower average peak and a less-than-5% chance that the difference is luck (one-sided permutation test).

**Known limit:** you know which mode each ride is in, so expectation can affect your ratings. That's unavoidable in a self-test; the rules above keep it as small as possible.

## How the cues work

- **Strength is shown by count, never by color alone**: 1 = slight, 2 = normal, 3 = sharp. This works on the green-only glasses display and for color-blind users. An optional phone-only color layer (green, amber, orange) can be turned on in Settings; if you use it, keep it on for the whole trial.
- **Before turns** (needs a destination): the route comes from OSRM; the phone's GPS tracks where you are along it, estimates when you'll reach each turn, and fires the cue 2 seconds early, correcting for GPS delay. Chevrons appear on the side of the turn (1, 2 or 3 of them) and the phone buzzes the same number of times: short buzzes for left, long buzzes for right. Roundabouts and U-turns show chevrons on both sides; arriving shows three dots and one very long buzz. If you leave the route, turn cues pause.
- **During braking and turning** (always, no destination needed): like iPhone's Vehicle Motion Cues, a sparse strip of dots on the left and right edges of the screen moves like the scenery outside the window, at the same moment the car moves. The middle of the screen stays clear.
  - **Turning:** the gyroscope measures how fast the car is turning. Turning left, the dots sweep right; turning right, they sweep left. A sharper turn sweeps faster.
  - **Braking / speeding up:** braking makes the dots stream up; speeding up makes them stream down. Harder braking streams faster.
  - **Seamless flow:** dot speed glides rather than jumps. Road vibration and sensor noise are smoothed out, dots ease in and out of view at the strip edges, and changes still show within about 0.15 seconds.
  - **Steady road:** at constant speed on a straight road the dots ease to a stop and fade out within about 1–2 seconds. Small bumps are ignored, so they don't flicker.
  - **Hills and phone tilt:** GPS speed is used to cancel out the pull of gravity on slopes, so a long hill doesn't look like braking. A long stop is never mistaken for a hill, so the dots don't drift the wrong way after the brakes come off.
  - The dots skip the area around the turn chevrons so both stay readable during a turn.
  - The phone's motion sensor is calibrated at the start; if the phone was mounted backwards, the app detects it from GPS speed changes and corrects itself. On the glasses (Phase 2), the same signal will be shown as 1–3 still dots instead: the G2 display can't animate smoothly (its developer guide says no animations; picture updates run at best a few per second over Bluetooth).

## Your data

Everything stays on the phone (browser storage). Results → **Download rides (CSV)** or **Download all data (JSON)** to share with Claude or your doctor. Destination searches go to OpenStreetMap's public services (Nominatim for search, OSRM for routes); nothing else leaves the phone. Clearing Chrome's site data deletes your rides, so export now and then.

This is a personal experiment, not a medical device.

## For developers

```
npm test          # 41 engine unit tests + 4 browser end-to-end tests
npm run build     # inlines engine + app into dist/index.html (single file, no dependencies)
```

`dist/index.html` must be served over HTTPS (or localhost): browsers only give location and motion data to secure pages. Map services used: `nominatim.openstreetmap.org` and `router.project-osrm.org` (public demo server, light personal use only; switch to a hosted routing API before sharing Andar with other people).
