import importlib

import pytest

MODULES = [
    "tanbala_leads",
    "tanbala_leads.cli",
    "tanbala_leads.settings",
    "tanbala_leads.db",
    "tanbala_leads.llm",
    "tanbala_leads.knowledge",
    "tanbala_leads.checks",
    "tanbala_leads.contact_policy",
    "tanbala_leads.steps.collect",
    "tanbala_leads.steps.crawl",
    "tanbala_leads.steps.qualify",
    "tanbala_leads.steps.verify",
    "tanbala_leads.steps.draft",
    "tanbala_leads.steps.review",
    "tanbala_leads.steps.approve",
    "tanbala_leads.steps.send",
    "tanbala_leads.steps.replies",
]


@pytest.mark.parametrize("name", MODULES)
def test_module_imports(name):
    importlib.import_module(name)
