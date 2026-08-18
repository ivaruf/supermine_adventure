# SUPERMINE ADVENTURE

Run a mining company.

Buy the rights to a mine, fill the tank, and drive a tracked excavation rig down
through sealed levels of rock. The ground is thousands of physical particles, not
tiles — it erupts, tumbles, piles up and closes around you. Ore goes into a hold
that has **volume**, not just value. Fuel, heat and hull integrity all run
against you, and the lift is the only way out.

Come back up with a full hold and sell. Or push one level deeper and find out
whether you can still afford the climb.

## Run it

No build step, no dependencies, no network. Open `index.html` directly in a
browser, or serve the folder if you prefer:

```
python3 -m http.server 8000
# then http://localhost:8000
```

It also installs as a PWA and plays offline.

## Controls

| Input | Action |
|---|---|
| Drag anywhere | the thumbstick — drive |
| W A S D or arrows | drive |
| M | mute |
| R | restart the descent |

Everything else is on screen: the pause plate in the mine, the door menu inside
the lift, and the workshop between runs.

## The loop

**Prepare → Enter → Explore → Drill → Fill → Push or run → Escape → Sell →
Upgrade → Unlock.**

* Each **level** is its own sealed map. Deeper levels are wider, hotter and
  harder, and are bought one at a time.
* The **lift** is a set of big doors at the top-centre of every level. Drive in
  and the machine disappears into the cage; the door menu is the whole surface
  loop — sell, refuel, ride to another level, or leave for the map.
* The **workshop** sells eight categories of part across priced tiers. Every one
  of them shows up on the machine — a bought upgrade you cannot see is a bug by
  definition.
* **Tunnels persist.** The holes you dug are saved per mine and are still there
  when you come back.
* Three **save slots**, in `localStorage`.

## Code

Plain ES5-style JavaScript on a single `SM` namespace, classic `<script>` tags
(works from `file://`), Canvas 2D, everything procedural — no images, no fonts,
no libraries. The engine simulates ~5 000 pooled particles with a spatial hash,
sleeping, and pre-baked sprite atlases, and holds 120 fps in headless Chrome.

See **`ARCHITECTURE.md`** for the module map, the load and init order, the event
contract, the levels-as-maps contract and the performance budget. Read it before
changing anything — several of the constraints in there are silent when broken.

`ROADMAP.md` is the design backlog.

## Where this came from

This game was **split out of SUPERMINE**, which shipped it as a second mode
alongside a 60-second time-attack score attack. Here the campaign is the whole
game: the time-attack director, the upgrade-gate system, the classic terrain
streamer and the entire classic HUD are gone, and the game boots straight into
the company screens.

Saves carry over. The `localStorage` key is unchanged, so a company started in
the two-mode build loads here exactly as it was.
