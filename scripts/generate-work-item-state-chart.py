#!/usr/bin/env python3
"""Render docs/architecture/work-item-state-chart.svg from src/modules/graph/work-item.scxml.

This is a lightweight authoring-time utility for issue #199. The SCXML file remains
canonical; this script derives a reviewer-friendly SVG by parsing the committed
SCXML structure and emitting a Graphviz DOT graph, then invoking `dot -Tsvg`.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

SCXML_PATH = Path("src/modules/graph/work-item.scxml")
SVG_PATH = Path("docs/architecture/work-item-state-chart.svg")
NS = {"s": "http://www.w3.org/2005/07/scxml"}


def normalize_target(raw: str | None) -> str | None:
    if not raw:
        return raw
    if raw.startswith("../"):
        return raw.split("/")[-1]
    return raw


def collect_transitions(root: ET.Element) -> list[tuple[str, str, str]]:
    transitions: list[tuple[str, str, str]] = []
    for child in root:
        tag = child.tag.split("}")[-1]
        state_id = child.get("id")
        if tag == "state" and state_id == "pre_pr":
            for tr in child.findall("s:transition", NS):
                transitions.append((state_id, normalize_target(tr.get("target")) or "", tr.get("event") or ""))
            for sub in child:
                subtag = sub.tag.split("}")[-1]
                sub_id = sub.get("id")
                if subtag == "history":
                    for tr in sub.findall("s:transition", NS):
                        transitions.append((sub_id or "", normalize_target(tr.get("target")) or "", tr.get("event") or "default"))
                elif subtag == "state":
                    for tr in sub.findall("s:transition", NS):
                        transitions.append((sub_id or "", normalize_target(tr.get("target")) or "", tr.get("event") or ""))
        elif tag == "state":
            for tr in child.findall("s:transition", NS):
                transitions.append((state_id or "", normalize_target(tr.get("target")) or "", tr.get("event") or ""))
    return transitions


def build_dot() -> str:
    root = ET.parse(SCXML_PATH).getroot()
    transitions = collect_transitions(root)

    lines: list[str] = []
    lines.append("digraph WorkItemStateChart {")
    lines.append('  graph [fontname="Helvetica", rankdir=LR, bgcolor="white", pad=0.2, nodesep=0.45, ranksep=0.7];')
    lines.append('  node [fontname="Helvetica", shape=rect, style="rounded,filled", color="#1f2937", fillcolor="#f8fafc", penwidth=1.2];')
    lines.append('  edge [fontname="Helvetica", color="#475569", arrowsize=0.8];')
    lines.append('  __start [shape=point, width=0.16, color="#0f172a"];')
    lines.append('  __start -> planned [label="initial", color="#0f172a"];')
    lines.append('  subgraph cluster_pre_pr {')
    lines.append('    label="pre_pr";')
    lines.append('    color="#94a3b8";')
    lines.append('    style="rounded";')
    lines.append('    pre_pr_history [shape=circle, width=0.32, height=0.32, fixedsize=true, label="H", fillcolor="#e0f2fe"];')
    for node in ["planned", "drafting", "ready", "in_progress", "run_errored"]:
        lines.append(f'    {node} [label="{node}"];')
    lines.append('  }')
    lines.append('  open_pr [label="open_pr", fillcolor="#eff6ff"];')
    lines.append('  merged_pr [label="merged_pr", fillcolor="#ecfccb"];')
    lines.append('  closed [label="closed", fillcolor="#fef3c7"];')
    lines.append('  deferred [label="deferred", fillcolor="#ede9fe"];')
    lines.append('  done [shape=doublecircle, label="done", fillcolor="#dcfce7"];')
    lines.append('  archived [shape=doublecircle, label="archived", fillcolor="#dbeafe"];')
    lines.append('  cancelled [shape=doublecircle, label="cancelled", fillcolor="#fee2e2"];')
    lines.append('  { rank=same; planned; drafting; ready; in_progress; run_errored; }')
    lines.append('  { rank=same; open_pr; merged_pr; closed; deferred; }')
    lines.append('  { rank=same; done; archived; cancelled; }')

    pre_pr_children = ["planned", "drafting", "ready", "in_progress", "run_errored"]
    for src, dst, event in transitions:
        if src == "pre_pr":
            for child in pre_pr_children:
                lines.append(f'  {child} -> {dst} [label="{event}", style=dashed, color="#7c3aed"];')
        elif src == "pre_pr_history":
            lines.append(f'  pre_pr_history -> {dst} [label="{event}", style=dotted];')
        else:
            lines.append(f'  {src} -> {dst} [label="{event}"];')

    lines.append("}")
    return "\n".join(lines)


def main() -> int:
    if not SCXML_PATH.exists():
        print(f"Missing SCXML source: {SCXML_PATH}", file=sys.stderr)
        return 1

    SVG_PATH.parent.mkdir(parents=True, exist_ok=True)
    dot_source = build_dot()
    subprocess.run(["dot", "-Tsvg", "-o", str(SVG_PATH)], input=dot_source, text=True, check=True)
    print(f"Wrote {SVG_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
