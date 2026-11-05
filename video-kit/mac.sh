#!/usr/bin/env bash
# Temporary video helper (not for merge). Run from the repo root on a machine
# that can reach api.meta.ai and is signed in to the AWS CLI:
#   MODEL_API_KEY=... bash video-kit/mac.sh
# Makes the Polly voiceover and the real Muse Git plan + assessments, saves them
# in video-assets/ and commits them locally (it never pushes, never writes the key).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${MODEL_API_KEY:?set MODEL_API_KEY in the environment}"
K=video-kit; O=video-assets; B=http://localhost:8089
if [ "${SKIP_POLLY:-}" = 1 ]; then rm -f "$O"/*.json "$O"/server.log; else rm -rf "$O"; fi; mkdir -p "$O/audio"
[ -x target/debug/vibeforge-server ] && [ -f web/dist/index.html ] || { echo "Build first: (cd web && npm ci && npm run build) && cargo build"; exit 1; }

echo "== 1/3 Polly voiceover"
[ "${SKIP_POLLY:-}" = 1 ] && echo "   skipped (keeping video-assets/audio)" || python3 - <<'PY'
import json, subprocess
for n in json.load(open('video-kit/narration-v2.json')):
    subprocess.run(['aws', 'polly', 'synthesize-speech', '--region', 'eu-central-1', '--engine', 'generative',
                    '--voice-id', 'Matthew', '--output-format', 'mp3', '--sample-rate', '24000',
                    '--text', n['text'], f"video-assets/audio/{n['id']}.mp3"], check=True, stdout=subprocess.DEVNULL)
    print('  ', n['id'])
PY
cp "$K/narration-v2.json" "$O/narration.json"

echo "== 2/3 Muse Git plan and assessments"
D=$(mktemp -d)
lsof -ti tcp:8089 2>/dev/null | xargs kill 2>/dev/null || true; sleep 1
for z in recipe-box recipe-box-mobile ops-dashboard; do base64 -d < "$K/$z.zip.gz.b64" | gunzip > "$D/$z.zip"; done
DATA_DIR="$D/data" PORT=8089 ./target/debug/vibeforge-server > "$D/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -fs $B/health >/dev/null 2>&1 && break; sleep 0.5; done
j(){ python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
J=$(curl -fs $B/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"admin@vibeforge.local","password":"admin12345"}' | j '["token"]')
H=(-H "authorization: Bearer $J")
KT=$(curl -s -X POST $B/api/v1/admin/ai/test "${H[@]}" -H 'content-type: application/json' -d '{}')
if echo "$KT" | grep -q '"ok":true'; then echo "   key check: Muse answered"; else
  echo "STOP: Muse did not accept the key: $(echo "$KT" | cut -c1-200)"; echo "Check MODEL_API_KEY: paste the real key, not the placeholder."; exit 1; fi
T=$(curl -fs $B/api/v1/me/tokens "${H[@]}" -H 'content-type: application/json' -d '{"name":"video"}' | j '["token"]')
curl -fs -X PUT $B/api/v1/me/git "${H[@]}" -H 'content-type: application/json' -d '{"name":"Ada Lovelace","email":"ada@example.com","username":"ada-builds","remote_protocol":""}' >/dev/null
proj(){ local sp p; sp=$(curl -fs $B/api/v1/spaces "${H[@]}" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" | j '["id"]')
  p=$(curl -fs $B/api/v1/spaces/$sp/projects "${H[@]}" -H 'content-type: application/json' -d "{\"name\":\"$2\"}" | j '["id"]')
  curl -fs -X POST $B/api/v1/projects/$p/milestones -H "authorization: Bearer $T" -H 'content-type: application/zip' -H "X-Milestone-Label: $3" --data-binary @"$D/$4.zip" | j '["milestone_id"]'; }
RB=$(proj "Acme Studio" "Recipe Box" "first version" recipe-box)
RM=$(proj "Kitchen Team" "Recipe Box Mobile" "Premium plan and App Store build" recipe-box-mobile)
OD=$(proj "Support Tools" "Ops Dashboard" "first version" ops-dashboard)
curl -fs -X POST $B/api/v1/milestones/$RB/git/suggest "${H[@]}" >/dev/null
st(){ curl -fs "$B/api/v1/milestones/$1/$2" "${H[@]}" | python3 -c "import sys,json;d=json.load(sys.stdin);x=d.get('$3') or {};print(x.get('status','none'))"; }
for i in $(seq 1 150); do
  s="$(st $RB git suggestion) $(st $RB ai-assessment assessment) $(st $RM ai-assessment assessment) $(st $OD ai-assessment assessment)"
  echo "   [$i] git/rb/mobile/ops: $s"
  case "$s" in *running*|*none*) sleep 4;; *) break;; esac
done
curl -fs $B/api/v1/milestones/$RB/git "${H[@]}" > "$O/git-plan.json"
for m in $RB $RM $OD; do curl -fs $B/api/v1/milestones/$m/ai-assessment "${H[@]}" > "$O/assess-$m.json"; done
python3 - "$D/data/db.json" "$O/muse-store.json" "$RB" "$RM" "$OD" <<'PY'
import json, sys
db = json.load(open(sys.argv[1])); rb, rm, od = sys.argv[3:6]
out = {'ids': {'recipe_box': rb, 'recipe_box_mobile': rm, 'ops_dashboard': od},
       'assessments': db['ai']['assessments'], 'suggestions': db['git']['suggestions'], 'previews': db['ai'].get('previews', {})}
json.dump(out, open(sys.argv[2], 'w'), indent=1)
for k, a in out['assessments'].items(): print('  ', k, a['status'], a.get('readiness'), a.get('risk'), len(a.get('issues', [])), 'issues', a.get('error') or '')
for k, s in out['suggestions'].items(): print('   git', k, s['status'], s.get('error') or '')
PY
cp "$D/server.log" "$O/server.log"

echo "== 3/3 Check and commit"
if grep -rqF "$MODEL_API_KEY" "$O"; then echo "STOP: the API key appears in $O"; exit 1; fi
for f in "$O"/audio/*.mp3; do printf '   %s %ss\n' "$(basename "$f")" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null || echo ?)"; done
git add "$O" && git commit -qm "chore: temporary video assets v2 (not for merge)" && git log --oneline -1
echo "Done. Now run: git push -f origin HEAD:claude/project-thread-7rao18"
