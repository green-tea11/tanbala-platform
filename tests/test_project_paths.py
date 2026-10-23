import os
from pathlib import Path

import tanbala_leads

ROOT = Path(__file__).resolve().parents[1]


def test_browsers_and_crawl4ai_data_stay_inside_project():
    assert Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]) == ROOT / ".browsers"
    # crawl4ai кладёт global.yml рядом со своей папкой, поэтому база тоже внутри .crawl4ai.
    assert Path(os.environ["CRAWL4_AI_BASE_DIRECTORY"]) == ROOT / ".crawl4ai"
    assert tanbala_leads.PROJECT_ROOT == ROOT
