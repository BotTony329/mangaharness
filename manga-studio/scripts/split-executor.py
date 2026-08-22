#!/usr/bin/env python3
"""One-shot mechanical split of src/agent/executor.ts into src/agent-v2/*.
Reads executor.ts, assigns top-level blocks to modules, rewrites module-global
state accesses to an explicit RunContext, prunes unused imports per file."""
import re, pathlib

SRC = pathlib.Path("src/agent/executor.ts")
lines = SRC.read_text().split("\n")

# declaration line numbers (1-based) discovered by inspection
DECLS = [71,73,79,105,190,212,219,348,366,380,385,397,461,467,471,490,515,526,556,568,581,587,620,657,705,737,745,777,812,890,895,924,943,956,1006,1036,1058,1124,1151,1180,1207,1237,1364,1495,1531,1541,1558,1592,1615,1650,1674,1689,1702]
END = len(lines)

# capture preceding comment block for each decl
def start_of(i):
    j = i - 2  # 0-based line above decl
    while j >= 0 and (lines[j].strip().startswith(("*","/*","//")) or lines[j].strip()==""):
        # stop at blank line preceded by non-comment
        if lines[j].strip()=="" :
            # peek further up: if comment continues, keep going
            k=j-1
            if k>=0 and lines[k].strip().startswith(("*","/*","//")):
                j-=1; continue
            break
        j-=1
    return j+1

blocks=[]  # (start0, end0_exclusive, decl_line)
for n,d in enumerate(DEELS if False else DECLS):
    s=start_of(d)
    e = (DECLS[n+1]-1) if n+1<len(DECLS) else END
    # trim trailing blank lines
    while e-1>=s and lines[e-1].strip()=="": e-=1
    blocks.append((s,e,d))

header = "\n".join(lines[:70])  # imports + file docstring (lines 1..70)

def text_of(d):
    for s,e,dd in blocks:
        if dd==d: return "\n".join(lines[s:e])
    raise KeyError(d)

FILES = {
 "types.ts": [71,73,79,190,348],
 "process/shared.ts": [461,467,471,515,568,812],
 "process/characterProcess.ts": [490,526,657,620,705,777,1650],
 "process/sceneProcess.ts": [556,587,737,745],
 "process/panelProcess.ts": [581,890,895,1036],
 "process/interactionProcess.ts": [366,1058],
 "process/cameraProcess.ts": [1495,1531,1592,1674,1541,1558,1689,1702],
 "process/dialogueProcess.ts": [924,1615],
 "process/toneProcess.ts": [943,956,1006,1124,1151,1180],
 "validation/index.ts": [1207,1237,1364],
 "orchestrator.ts": [105,212,219,380,385,397],
}

# ctx rewrites applied to handler bodies (not shared.ts definitions)
CTX_REWRITES = [
    (r"\bactiveGuards\b","ctx.guards"),
    (r"\bcreatedCharacterIds\b","ctx.createdCharacterIds"),
    (r"\blastLanguageAction\b","ctx.lastLanguageAction"),
    (r"\bcurrentDoc\(\)","ctx.currentDoc()"),
    (r"\bdispatch\(","ctx.dispatch("),
    (r"\bpanelIdByNumber\(","ctx.panelIdByNumber("),
    (r"\bstageOnWorkspace\(","ctx.stageOnWorkspace("),
    (r"\brequireCharacterOrNull\(","ctx.requireCharacterOrNull("),
    (r"\bfindTargetInstance\(","ctx.findTargetInstance("),
]

# cross-process calls that need ctx as first arg
CALLS = [
    (r"\bresolveOrGenerateState\(","ctx"),(r"\bapproximateInteraction\(","ctx"),
    (r"\bdoGenerateScenery\(","ctx"),(r"\bplaceLanguageAssetOnTarget\(","ctx"),
    (r"\bmaskOverCharacter\(","ctx"),(r"\bcharacterInstanceInPanel\(","ctx"),
    (r"\bpanelCharacterIds\(","ctx"),
]

def transform(body, fname):
    if fname != "process/shared.ts":
        for pat,rep in CTX_REWRITES:
            body=re.sub(pat,rep,body)
        # add ctx param to exported/internal function declarations
        body=re.sub(r"(export )?(async )?function (\w+)\(",
                    lambda m: f"{m.group(1) or 'export '}{m.group(2) or ''}function {m.group(3)}(ctx: RunContext, " if not m.group(1) else f"export {m.group(2) or ''}function {m.group(3)}(ctx: RunContext, ",
                    body)
        for pat,_ in CALLS:
            body=re.sub(pat, lambda m: m.group(0)+"ctx, ", body)
    return body

out=pathlib.Path("src/agent-v2"); (out/"process").mkdir(parents=True,exist_ok=True); (out/"validation").mkdir(parents=True,exist_ok=True)
for fname,decls in FILES.items():
    parts=[transform(text_of(d),fname) for d in decls]
    (out/fname).write_text("\n\n".join(parts)+"\n")
    print(fname, sum(p.count("\n") for p in parts))
print("done")
