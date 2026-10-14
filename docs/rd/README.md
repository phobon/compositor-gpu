# R&D Tax Incentive records

Records for claiming compositor-gpu work under the Australian R&D Tax
Incentive (software sector guide:
https://business.gov.au/grants-and-programs/research-and-development-tax-incentive/sector-guides-for-r-and-d-tax-incentive-applicants/software-development).

This folder is the evidence base. Write entries while the work happens, not
afterwards: an assessor gives more weight to records made at the time.

## Key dates

| Item | Date |
| --- | --- |
| Work began | 2026-09-24 (commit `5bf8b97`) |
| Income year | FY2026-27 (2026-07-01 to 2027-06-30) |
| Registration due | 2028-04-30 (10 months after year end) |

## Files

| File | What it is | Update when |
| --- | --- | --- |
| `activities-fy2026-27.md` | Draft core and supporting activity descriptions for the registration | An experiment concludes, or an activity's scope changes |
| `prior-art.md` | What existing solutions were checked and why they don't solve each hurdle | Before starting a new core activity; when new prior art appears |
| `experiments/` | One file per experiment, from `templates/experiment.md` | Before starting the experiment (hypothesis), then as results come in |
| `reviews/` | Short notes from reviews and decisions (why an experiment was needed, what was dropped), from `templates/review.md` | After each decision point |
| `records/timesheet.csv` | Hours per person per activity, weekly | Weekly |
| `records/expenditure.csv` | Costs and the share attributable to R&D | When an invoice arrives |
| `evidence/` | Dated copies of harness output tied to an experiment (`last.json`, parity tables, diff PNGs, profiles) | At the end of each experiment run |
| `templates/` | Blank templates for the above | Rarely |

## Activity codes

Use these in timesheets, expenditure and experiment files.

| Code | Activity | Type |
| --- | --- | --- |
| C1 | Real-time per-glyph geometry from browser layout | Core |
| C2 | Low-latency DOM-to-GPU synchronisation at pixel parity | Core |
| C3 | Outline text rendering matched to browser layout | Core (to confirm with adviser) |
| S1 | Test and measurement harnesses (visual, perf, profile, site) | Supporting C1-C3 |
| S2 | Rendering passes needed to measure parity (box, image, transforms, clips) | Supporting C2 |
| S3 | Third-party bug diagnosis (e.g. opentype.js gvar) | Supporting C3 |
| X | Not claimed: fx presets, React/DialKit, site integration, housekeeping | - |

## Workflow

1. New technical question with an unknown outcome: copy
   `templates/experiment.md` to `experiments/YYYY-MM-DD-<slug>.md` and fill
   in the hurdle and hypothesis before writing code.
2. Reference the experiment file in commit messages (`rd: C1 exp
   2026-10-14-safari-text-read`).
3. After each harness run that counts as a result, copy the output into
   `evidence/<experiment-slug>/` with the date in the filename. Goldens and
   `test/*/out/` are gitignored, so this is the only durable copy.
4. Close the experiment with a conclusion, even if the hypothesis failed.
   Failed experiments are good evidence.
5. Log hours weekly in `records/timesheet.csv`.

`evidence/` can get large. If that becomes a problem, keep it out of git and
store it somewhere backed up, but keep the folder structure.
