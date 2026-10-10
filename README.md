# Flight tracks

A globe showing where migratory birds are, week by week through the year. Pick a species, press play, and watch its populations move between continents.

The abundance glow comes from [eBird Status and Trends](https://ebird.org/science/status-and-trends) (Cornell Lab of Ornithology). The lines follow the weighted centre of each regional population, and the timeline shows how far north or south each population sits through the year.

## How it works

```
eBird Status and Trends ──> pipeline/build_data.py ──> site/data/ ──> GitHub Pages
 (weekly abundance, 27 km)   (reproject, render frames,   (PNG frames,
                              compute population paths)    paths, manifest)
```

- `pipeline/species.json` lists the species to build, with the names and notes shown on the site.
- `pipeline/build_data.py` downloads each species' 52-week abundance raster, converts it from the Equal Earth projection to latitude and longitude, renders one transparent PNG per week, and writes the population paths.
- `site/` is the website: plain HTML, CSS and JavaScript using three.js (bundled in `site/vendor/`), with no build step.
- `.github/workflows/build-and-deploy.yml` runs the pipeline and publishes the site on every push to `main`, or when run by hand.

The generated data in `site/data/` is not committed; the workflow builds it fresh each time. Downloads are cached between runs.

## Setup

1. **Add the eBird key as a secret.** In the repository, go to Settings > Secrets and variables > Actions > New repository secret. Name it `EBIRDST_KEY` and paste your eBird Status and Trends access key. (Request one at https://ebird.org/st/request.)
2. **Turn on Pages.** Settings > Pages > Build and deployment > Source: choose **GitHub Actions**.
3. **Run the workflow.** Actions > Build data and deploy > Run workflow. The first run downloads about 10 species and takes a few minutes. The site address appears on the run's summary page.

## Adding species

Add an entry to `pipeline/species.json` with the eBird species code (the six-letter code in eBird URLs, for example `barswa` in `ebird.org/species/barswa`), the common and scientific names, and a short note. Push the change and the workflow rebuilds the site. Species that eBird Status and Trends doesn't cover are skipped and listed in the workflow log.

## Running locally

```
pip install -r pipeline/requirements.txt
EBIRDST_KEY=your-key python pipeline/build_data.py --only barswa
cd site && python -m http.server 8000
```

Then open http://localhost:8000.

## Data terms

eBird Status and Trends products are free for non-commercial use with attribution and a link to the project, under the [terms of use](https://ebird.org/about/products-access-terms-of-use). Commercial use needs written permission from the Cornell Lab. The site's "About this map" panel carries the required citation:

> Fink, D., T. Auer, A. Johnston, M. Strimas-Mackey, S. Ligocki, O. Robinson, W. Hochachka, L. Jaromczyk, C. Crowley, K. Dunham, A. Stillman, C. Davis, M. Stokowski, P. Sharma, V. Pantoja, D. Burgin, P. Crowe, M. Bell, S. Ray, I. Davies, V. Ruiz-Gutierrez, C. Wood, A. Rodewald. 2024. eBird Status and Trends, Data Version: 2023; Released: 2025. Cornell Lab of Ornithology, Ithaca, New York. https://doi.org/10.2173/WZTW8903

## Credits

- Globe rendering: [three.js](https://threejs.org) (MIT licence, bundled in `site/vendor/`).
- Base map: shaded by `tools/make_basemap.py` from the land and elevation images in [three-globe](https://github.com/vasturiano/three-globe) (MIT licence), derived from NASA imagery.
