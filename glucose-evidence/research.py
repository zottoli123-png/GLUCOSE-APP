"""Maintainer-only literature search and reviewed evidence packaging."""
import argparse
import hashlib
import json
import os
import re
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
TOPICS = {
    "monitoring": '"continuous glucose monitoring"[tiab] OR "self monitoring of blood glucose"[tiab]',
    "medication": '"medication adherence"[tiab] OR "medication errors"[tiab] OR "insulin administration"[tiab]',
    "digital-self-management": 'app[tiab] OR "mobile health"[tiab] OR "digital health"[tiab]',
    "access-and-distress": '"diabetes distress"[tiab] OR "health literacy"[tiab] OR "food insecurity"[tiab] OR "insulin affordability"[tiab] OR "health equity"[tiab]',
    "care-planning": 'caregiver*[tiab] OR "sick day"[tiab] OR "diabetes self-management education"[tiab]',
    "reporting": '"ambulatory glucose profile"[tiab] OR "glucose management indicator"[tiab] OR "time in range"[tiab] OR "hemoglobin a1c discordance"[tiab]',
}
POPULATIONS = {
    "all": '"diabetes mellitus"[mh] OR diabet*[tiab]',
    "pregnancy": '"Diabetes, Gestational"[mh] OR gestational[tiab] OR ((pregnancy[tiab] OR pregnant[tiab]) AND diabet*[tiab])',
    "older-adults": '("aged"[mh] OR "older adults"[tiab]) AND diabet*[tiab]',
    "children": '("child"[mh] OR "adolescent"[mh] OR pediatric*[tiab]) AND diabet*[tiab]',
}
PRIORITY = ('systematic[sb] OR randomized controlled trial[pt] OR guideline[pt] '
            'OR systematic review[tiab] OR meta-analysis[tiab] OR randomized[tiab] '
            'OR "retracted publication"[pt] OR "retraction of publication"[pt] '
            'OR "published erratum"[pt] OR "expression of concern"[pt]')

def request(endpoint, **params):
    time.sleep(0.37)
    with urlopen(BASE + endpoint + "?" + urlencode(
            {"db": "pubmed", "tool": "glucose_evidence", **params}), timeout=30) as response:
        return response.read()

def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     delete=False) as target:
        name = target.name
        try:
            json.dump(value, target, indent=2, sort_keys=True, ensure_ascii=False)
            target.write("\n")
            target.close()
            os.replace(name, path)
        finally:
            Path(name).unlink(missing_ok=True)

def articles(xml):
    for item in ET.fromstring(xml).findall("PubmedArticle/MedlineCitation"):
        pmid = item.findtext("PMID")
        article = item.find("Article")
        if not pmid or article is None:
            continue
        title = article.find("ArticleTitle")
        types = [node.text for node in article.findall("PublicationTypeList/PublicationType")]
        notices = [
            {"relation": node.get("RefType"), "pmid": node.findtext("PMID")}
            for node in item.findall("CommentsCorrectionsList/CommentsCorrections")
            if any(word in (node.get("RefType") or "").lower()
                   for word in ("retract", "errat", "concern", "update", "correct"))
        ]
        yield pmid, {
            "title": "".join(title.itertext()) if title is not None else "",
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "publication_types": types,
            "notices": notices,
            "priority_review": bool(notices) or any(
                any(word in (kind or "").lower() for word in ("erratum", "retract", "concern"))
                for kind in types),
        }

def discover(args):
    start = date.fromisoformat(args.since)
    end = date.fromisoformat(args.until)
    if start > end:
        raise ValueError("Start date must precede or equal end date")
    records = {}
    searches = {}
    for topic in args.topic or TOPICS:
        query = (f"({POPULATIONS[args.population]}) AND ({TOPICS[topic]}) AND "
                 f'("{start:%Y/%m/%d}"[dp] : "{end:%Y/%m/%d}"[dp])')
        if not args.broad:
            query += f" AND ({PRIORITY})"
        ids = []
        for offset in range(0, args.limit, 100):
            payload = json.loads(request("esearch.fcgi", term=query, retmode="json",
                                         sort="pub_date", retstart=offset,
                                         retmax=min(100, args.limit - offset)))
            result = payload["esearchresult"]
            if result.get("errorlist"):
                raise ValueError(result["errorlist"])
            total = int(result["count"])
            ids.extend(result["idlist"])
            if len(ids) >= total or not result["idlist"]:
                break
        unique = list(dict.fromkeys(ids))
        searches[topic] = {"query": query, "matches": total, "retrieved": len(unique),
                           "truncated": len(unique) < total}
        for offset in range(0, len(unique), 75):
            fetched = dict(articles(request("efetch.fcgi", id=",".join(unique[offset:offset + 75]),
                                            rettype="abstract", retmode="xml")))
            missing = set(unique[offset:offset + 75]) - fetched.keys()
            if missing:
                searches[topic].setdefault("unresolved_pmids", []).extend(sorted(missing))
            for pmid, entry in fetched.items():
                records.setdefault(pmid, {**entry, "topics": []})["topics"].append(topic)
    write(args.output, {"searched_on": date.today().isoformat(), "searches": searches,
                        "records": records})
    print(f"{len(records)} unique candidates. See search counts and unresolved IDs in {args.output}.")

def digest(card):
    payload = json.dumps(card, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def source_pmid(source):
    match = re.fullmatch(r"https://pubmed\.ncbi\.nlm\.nih\.gov/(\d+)/?", source["url"])
    return match[1] if match else None

def check_sources(cards, output):
    ids = sorted({pmid for card in cards for source in card["sources"]
                  if (pmid := source_pmid(source))})
    checked = {}
    for offset in range(0, len(ids), 75):
        checked.update(articles(request("efetch.fcgi", id=",".join(ids[offset:offset + 75]),
                                        rettype="abstract", retmode="xml")))
    missing = set(ids) - checked.keys()
    write(output, {"checked_on": date.today().isoformat(), "records": checked,
                   "unresolved_pmids": sorted(missing)})
    print(f"{len(checked)} sources checked, {len(missing)} unresolved. Review notices in {output}.")

def package(cards, decisions, queue, version):
    identifiers = set()
    checked = queue.get("records", {})
    checked_on = date.fromisoformat(queue["checked_on"])
    if not 0 <= (date.today() - checked_on).days <= 30:
        raise ValueError("Refresh the source check before packaging")
    included = []
    for card in cards:
        key = card["id"]
        if key in identifiers:
            raise ValueError(f"Duplicate card ID: {key}")
        identifiers.add(key)
        approval = decisions.get(key, {})
        if approval.get("status") != "approved":
            continue
        if approval.get("digest") != digest(card):
            raise ValueError(f"{key}: content changed since recorded review")
        if not approval.get("reviewer", "").strip():
            raise ValueError(f"{key}: reviewer missing")
        if date.fromisoformat(approval["reviewed_on"]) > date.today():
            raise ValueError(f"{key}: review date is in the future")
        if card["kind"] != "education":
            raise ValueError(f"{key}: only education cards can be packaged")
        for field in ("title", "finding", "population", "limitations"):
            if not isinstance(card[field], str) or not card[field].strip():
                raise ValueError(f"{key}: missing {field}")
        if not card["sources"]:
            raise ValueError(f"{key}: source required")
        for source in card["sources"]:
            if urlsplit(source["url"]).scheme != "https" or not urlsplit(source["url"]).hostname:
                raise ValueError(f"{key}: invalid source URL")
            pmid = source_pmid(source)
            if pmid and pmid not in checked:
                raise ValueError(f"{key}: PubMed source must be checked")
            if pmid and checked[pmid]["priority_review"]:
                raise ValueError(f"{key}: source has a publication notice requiring review")
        fields = ("id", "title", "population", "finding", "limitations", "evidence", "sources")
        included.append({**{field: card[field] for field in fields},
                         "reviewed_on": approval["reviewed_on"]})
    if not included:
        raise ValueError("No reviewed education cards are ready to package")
    return {"schema": 1, "version": version, "cards": included}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    search = sub.add_parser("discover")
    search.add_argument("--topic", action="append", choices=TOPICS)
    search.add_argument("--population", default="all", choices=POPULATIONS)
    search.add_argument("--since", default=(date.today()-timedelta(days=365)).isoformat())
    search.add_argument("--until", default=date.today().isoformat())
    search.add_argument("--limit", type=int, choices=range(1, 1001), metavar="1..1000", default=100)
    search.add_argument("--broad", action="store_true")
    search.add_argument("--output", default="candidates.json")
    hashes = sub.add_parser("hashes")
    hashes.add_argument("--cards", default="baseline.json")
    check = sub.add_parser("check-sources")
    check.add_argument("--cards", default="baseline.json")
    check.add_argument("--output", default="source-check.json")
    build = sub.add_parser("package")
    build.add_argument("--cards", default="baseline.json")
    build.add_argument("--decisions", default="decisions.json")
    build.add_argument("--source-check", required=True)
    build.add_argument("--version", required=True)
    build.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "discover":
            discover(args)
        elif args.command == "hashes":
            for card in read(args.cards):
                print(card["id"], digest(card))
        elif args.command == "check-sources":
            check_sources(read(args.cards), args.output)
        else:
            write(args.output, package(read(args.cards), read(args.decisions),
                                       read(args.source_check), args.version))
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        parser.exit(1, f"Evidence pipeline: {error}\n")

if __name__ == "__main__":
    main()
