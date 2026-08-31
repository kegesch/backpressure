import argparse
import fnmatch
import json
import os
import sys

DECISION_TYPES = {
    "if_statement",
    "while_statement",
    "do_statement",
    "for_statement",
    "for_in_statement",
    "switch_case",
    "catch_clause",
    "ternary_expression",
    "conditional_expression",
}
FUNCTION_TYPES = {"function_declaration", "method_definition", "arrow_function"}


def field_text(node, name):
    child = node.child_by_field_name(name)
    if child is None:
        return None
    return child.text.decode("utf-8", "replace")


def glob_match(pattern, rel):
    rel = rel.replace("\\", "/")
    pattern = pattern.replace("\\", "/")
    if pattern.endswith("/**"):
        base = pattern[: -3]
        return base == "" or rel.startswith(base + "/")
    if pattern.startswith("**/"):
        tail = pattern[3:]
        parts = rel.split("/")
        for i in range(len(parts)):
            if fnmatch.fnmatch("/".join(parts[i:]), tail):
                return True
        return False
    return rel == pattern


def rule_applies(rule, rel):
    for pattern in rule["exclude"]:
        if glob_match(pattern, rel):
            return False
    if rule["include"]:
        return any(glob_match(p, rel) for p in rule["include"])
    return True


def load_rules(config_path):
    import yaml

    with open(config_path, "r", encoding="utf-8") as handle:
        doc = yaml.safe_load(handle) or {}
    raw = doc.get("rules")
    if not isinstance(raw, list):
        return []
    rules = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        if item.get("language") != "typescript":
            continue
        max_cyclomatic = item.get("maxCyclomatic")
        if not isinstance(max_cyclomatic, (int, float)) or isinstance(max_cyclomatic, bool):
            continue
        rule_id = item.get("id")
        if not isinstance(rule_id, str) or rule_id == "":
            continue
        metadata = item.get("metadata")
        bp = metadata.get("backpressure") if isinstance(metadata, dict) else None
        bp = bp if isinstance(bp, dict) else {}
        paths = item.get("paths")
        paths = paths if isinstance(paths, dict) else {}
        include = paths.get("include")
        exclude = paths.get("exclude")
        rules.append(
            {
                "id": rule_id,
                "severity": item.get("severity"),
                "maxCyclomatic": max_cyclomatic,
                "include": [p for p in include if isinstance(p, str)] if isinstance(include, list) else [],
                "exclude": [p for p in exclude if isinstance(p, str)] if isinstance(exclude, list) else [],
            }
        )
    return rules


def function_entry(node):
    node_type = node.type
    if node_type == "arrow_function":
        parent = node.parent
        name = None
        if parent is not None:
            if parent.type == "variable_declarator":
                name = field_text(parent, "name")
            elif parent.type == "pair":
                name = field_text(parent, "key")
        if not name:
            name = "anonymous@L" + str(node.start_point[0] + 1)
    else:
        if node.child_by_field_name("body") is None:
            return None
        name = field_text(node, "name") or "anonymous@L" + str(node.start_point[0] + 1)
    return {"name": name, "startLine": node.start_point[0] + 1, "cyclomatic": 1}


def walk(node, stack, functions):
    node_type = node.type
    pushed = False
    if node_type in FUNCTION_TYPES:
        entry = function_entry(node)
        if entry is not None:
            functions.append(entry)
            stack.append(entry)
            pushed = True
    if stack:
        current = stack[-1]
        if node_type in DECISION_TYPES:
            current["cyclomatic"] += 1
        elif node_type == "binary_expression":
            if field_text(node, "operator") in ("&&", "||"):
                current["cyclomatic"] += 1
        elif node_type in ("assignment_expression", "augmented_assignment_expression"):
            if field_text(node, "operator") in ("&&=", "||=", "??="):
                current["cyclomatic"] += 1
    for child in node.children:
        walk(child, stack, functions)
    if pushed:
        stack.pop()


def iter_ts_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for filename in sorted(filenames):
            if filename.endswith(".ts") and not filename.endswith(".tsx"):
                yield os.path.join(dirpath, filename)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("root")
    args = parser.parse_args()

    from tree_sitter import Language, Parser
    from tree_sitter_typescript import language_typescript

    rules = load_rules(args.config)
    by_id = {r["id"]: r for r in rules}
    lang = Language(language_typescript())
    tree_parser = Parser(lang)
    findings = []
    for file_path in iter_ts_files(args.root):
        rel = os.path.relpath(file_path, args.root)
        matching = [r for r in rules if rule_applies(r, rel)]
        if not matching:
            continue
        with open(file_path, "rb") as handle:
            source = handle.read()
        tree = tree_parser.parse(source)
        found = []
        walk(tree.root_node, [], found)
        for entry in found:
            for rule in matching:
                max_cyclomatic = rule["maxCyclomatic"]
                if entry["cyclomatic"] <= max_cyclomatic:
                    continue
                severity = rule["severity"]
                if not isinstance(severity, str) or severity == "":
                    severity = "INFO"
                findings.append(
                    {
                        "ruleId": rule["id"],
                        "file": file_path,
                        "startLine": entry["startLine"],
                        "message": "function '%s' cyclomatic complexity %d exceeds max %s"
                        % (entry["name"], entry["cyclomatic"], max_cyclomatic),
                        "severity": severity,
                    }
                )
    print(json.dumps({"findings": findings}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("complexity_scan crashed\n")
        sys.exit(1)
