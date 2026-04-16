"""
generate_kg_json.py
-------------------
graph_store_step3_only.json 에서 연결성 기반 상위 200개 노드를 샘플링하여
vis.js 에서 바로 사용할 수 있는 kg_data.json 으로 변환합니다.

실행:
    python generate_kg_json.py
"""
import json
import sys
from collections import Counter

MAX_NODES = 200
INPUT  = "Financial_AI_Agent/graph_store_step3_only.json"
OUTPUT = "kg_data.json"

NODE_COLORS = {
    "Company":        "#4FC3F7",
    "Event":          "#FF8A65",
    "Industry":       "#81C784",
    "Document":       "#CE93D8",
    "Evidence":       "#FFD54F",
    "Institution":    "#F48FB1",
    "Region":         "#80DEEA",
    "Commodity":      "#BCAAA4",
    "EventCandidate": "#B0BEC5",
    "Exchange":       "#90A4AE",
}

NODE_SHAPES = {
    "Company":        "dot",
    "Event":          "diamond",
    "Industry":       "hexagon",
    "Document":       "square",
    "Evidence":       "triangle",
    "Institution":    "dot",
    "Region":         "dot",
    "Commodity":      "dot",
    "EventCandidate": "dot",
    "Exchange":       "dot",
}

NODE_SIZES = {
    "Company": 22, "Event": 18, "Industry": 16,
    "Document": 14, "Evidence": 12, "Institution": 16,
    "Region": 14, "Commodity": 14, "EventCandidate": 10, "Exchange": 14,
}

NODE_ICONS = {
    "Company": "🏢", "Event": "⚡", "Industry": "🏭",
    "Document": "📄", "Evidence": "🔎", "Institution": "🏦",
    "Region": "🌍", "Commodity": "📦", "EventCandidate": "🧩", "Exchange": "🏛",
}

EDGE_COLORS = {
    "HAS_EVENT":            "#FF8A65",
    "HAS_EVENT_CANDIDATE":  "#B0BEC5",
    "BELONGS_TO_INDUSTRY":  "#81C784",
    "INVOLVES":             "#4FC3F7",
    "SUPPORTED_BY":         "#FFD54F",
    "FROM_DOCUMENT":        "#CE93D8",
    "CANONICALIZED_TO":     "#CFD8DC",
    "PRECEDES":             "#EF9A9A",
    "DISCLOSED_IN":         "#BA68C8",
    "REPORTED_IN":          "#9575CD",
    "LISTED_ON":            "#80CBC4",
}


def get_display_name(label, props, node_id):
    if label == "Company":
        return props.get("name") or node_id[:12]
    if label == "Event":
        trigger = props.get("trigger_text", "")
        subtype = props.get("event_subtype") or props.get("event_type", "")
        if trigger and subtype:
            return f"{trigger[:15]} [{subtype}]"
        return trigger[:20] or subtype or node_id[:12]
    if label in ("Evidence", "Document"):
        text = props.get("text") or props.get("title") or node_id[:12]
        return text[:25] + ("..." if len(text) > 25 else "")
    return props.get("name") or props.get("title") or node_id[:12]


def build_tooltip(label, props, node_id):
    icon = NODE_ICONS.get(label, "•")
    lines = [f"<b>{icon} {label}</b><br/>"]
    skip = {"created_at", "updated_at", "node_id", "canonical_entity_id"}
    for k, v in props.items():
        if v and k not in skip:
            val = str(v)
            if len(val) > 60:
                val = val[:60] + "..."
            lines.append(f"<b>{k}:</b> {val}<br/>")
    return "".join(lines)


def select_connected_nodes(nodes_list, edges_list, max_nodes):
    if len(nodes_list) <= max_nodes:
        return nodes_list

    node_map = {n["node_id"]: n for n in nodes_list}
    degree    = Counter()
    neighbors = {}

    for e in edges_list:
        sid, tid = e["source_id"], e["target_id"]
        degree[sid] += 1
        degree[tid] += 1
        neighbors.setdefault(sid, set()).add(tid)
        neighbors.setdefault(tid, set()).add(sid)

    label_bonus = {
        "Company": 0.30, "Event": 0.25, "Evidence": 0.20,
        "EventCandidate": 0.15, "Document": 0.10,
    }

    ranked = sorted(
        nodes_list,
        key=lambda n: (
            degree.get(n["node_id"], 0),
            n["properties"].get("confidence", 0.5) + label_bonus.get(n["label"], 0.0),
        ),
        reverse=True,
    )

    selected = set()
    for n in ranked:
        if len(selected) >= max_nodes:
            break
        if degree.get(n["node_id"], 0) == 0:
            continue
        selected.add(n["node_id"])

    for nid in list(selected):
        if len(selected) >= max_nodes:
            break
        for nbr in sorted(
            neighbors.get(nid, set()),
            key=lambda x: degree.get(x, 0), reverse=True
        ):
            if len(selected) >= max_nodes:
                break
            selected.add(nbr)

    # Fill up remaining quota
    for n in ranked:
        if len(selected) >= max_nodes:
            break
        selected.add(n["node_id"])

    return [node_map[nid] for nid in selected if nid in node_map]


def main():
    print(f"Reading {INPUT} ...")
    with open(INPUT, "r", encoding="utf-8") as f:
        data = json.load(f)

    all_nodes = data["nodes"]
    all_edges = data["edges"]
    print(f"Total: {len(all_nodes)} nodes, {len(all_edges)} edges")

    sampled_nodes = select_connected_nodes(all_nodes, all_edges, MAX_NODES)
    sampled_ids   = {n["node_id"] for n in sampled_nodes}
    print(f"Sampled: {len(sampled_nodes)} nodes")

    # Build vis.js nodes array
    vis_nodes = []
    for n in sampled_nodes:
        label  = n["label"]
        props  = n["properties"]
        nid    = n["node_id"]
        name   = get_display_name(label, props, nid)
        icon   = NODE_ICONS.get(label, "•")
        color  = NODE_COLORS.get(label, "#aaaaaa")
        shape  = NODE_SHAPES.get(label, "dot")
        size   = NODE_SIZES.get(label, 14)
        tooltip = build_tooltip(label, props, nid)

        vis_nodes.append({
            "id":    nid,
            "label": f"{icon} {name}",
            "title": tooltip,
            "color": {"background": color, "border": color,
                      "highlight":  {"background": "#ffffff", "border": color}},
            "shape": shape,
            "size":  size,
            "font":  {"color": "#ffffff", "size": 12,
                      "strokeWidth": 2, "strokeColor": "#1a1a2e"},
            "borderWidth": 2,
            "borderWidthSelected": 4,
            "group": label,
        })

    # Build vis.js edges array
    vis_edges = []
    for e in all_edges:
        if e["source_id"] in sampled_ids and e["target_id"] in sampled_ids:
            etype  = e["edge_type"]
            ecolor = EDGE_COLORS.get(etype, "#888888")
            conf   = e["properties"].get("confidence")
            elabel = f"{etype}\n{conf:.2f}" if isinstance(conf, (float, int)) else etype

            vis_edges.append({
                "from":   e["source_id"],
                "to":     e["target_id"],
                "label":  elabel,
                "title":  etype,
                "color":  {"color": ecolor, "opacity": 0.8},
                "width":  2.0,
                "arrows": {"to": {"enabled": True, "scaleFactor": 0.6}},
                "smooth": {"type": "curvedCW", "roundness": 0.2},
                "font":   {"size": 9, "color": "#aaaaaa", "strokeWidth": 0},
            })

    label_counts = Counter(n["label"] for n in sampled_nodes)
    output = {
        "nodes": vis_nodes,
        "edges": vis_edges,
        "stats": {
            "nodes": len(vis_nodes),
            "edges": len(vis_edges),
            **dict(label_counts.most_common(6)),
        },
    }

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Saved to {OUTPUT}")
    print(f"Stats: {label_counts.most_common(6)}")


if __name__ == "__main__":
    main()
