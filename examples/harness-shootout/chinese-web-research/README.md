# Chinese Web Research Profile

This deterministic fixture adds a multilingual web-research benchmark profile
without depending on a live search provider or copying external benchmark data.
It is inspired by Level-Navi Agent and BrowseComp-ZH task shapes, but the
sources and task cases here are hand-authored fixtures for licensing and CI
reproducibility.

The profile exercises:

- Chinese source titles and snippets that must survive report rendering.
- Required citations for source-grounded answers.
- Cross-source reconciliation for multi-hop questions.
- Stale-source detection when an older snippet contradicts later evidence.
- Provider-agnostic live-search gating through `webResearch.liveSearch`.

This is not a generic RAG diagnostics profile. RAG diagnostics usually evaluate
retrieval over a controlled corpus. This profile evaluates browser/search-style
research behavior: source language, citation coverage, answer uniqueness,
evidence reconciliation, stale web evidence, and rendered Chinese text.

The default fixture is evidence infrastructure only. It does not claim
BrowseComp-ZH, Level-Navi Agent, ChinaXiv, Harbor, or Terminal-Bench score
movement. Live Chinese web/search runs need a provider-backed adapter and a
same-profile before/after comparison before any score-improvement claim.
