# state/

`ads.json` appears here after the first run. It holds every ad the tracker has seen, per
competitor, and what each destination has already received. The scheduled workflow commits
it after every run, so the next run only sends what is new.

- Delete `ads.json` to start over (the next run is a "now tracking" summary again). It also
  remembers which Notion page belongs to which ad, so empty the Notion database too or the
  ads are added a second time.
- Remove one competitor's block to reset only that competitor (same note for Notion).
- Its git history is a day-by-day record of your competitors' ads.
