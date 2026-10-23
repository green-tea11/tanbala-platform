import os
from pathlib import Path

import tanbala_leads

ROOT = Path(__file__).resolve().parents[1]


def test_browsers_and_crawl4ai_data_stay_inside_project():
    assert Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]) == ROOT / ".browsers"
    assert Path(os.environ["CRAWL4_AI_BASE_DIRECTORY"]) == ROOT
    assert tanbala_leads.PROJECT_ROOT == ROOT
