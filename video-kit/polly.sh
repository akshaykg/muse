#!/usr/bin/env bash
# Temporary video helper (not for merge): voice only the given narration lines.
#   bash video-kit/polly.sh 00-problem 01-intro
# Writes video-assets/audio/<id>.mp3 (+ word timings in video-assets/marks/ when Polly offers them) and commits locally.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p video-assets/audio video-assets/marks
python3 - "$@" <<'PY'
import json, subprocess, sys
want = set(sys.argv[1:])
for n in json.load(open('video-kit/narration-v3.json')):
    if n['id'] not in want: continue
    base = ['aws', 'polly', 'synthesize-speech', '--region', 'eu-central-1', '--engine', 'generative', '--voice-id', 'Matthew', '--text', n['text']]
    subprocess.run(base + ['--output-format', 'mp3', '--sample-rate', '24000', f"video-assets/audio/{n['id']}.mp3"], check=True, stdout=subprocess.DEVNULL)
    r = subprocess.run(base + ['--output-format', 'json', '--speech-mark-types', 'word', f"video-assets/marks/{n['id']}.json"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('  ', n['id'], 'marks' if r.returncode == 0 else 'no marks')
PY
cp video-kit/narration-v3.json video-assets/narration.json
git add video-assets && git commit -qm "chore: temporary video assets v3 opening (not for merge)" && git log --oneline -1
echo "Done. Now run: git push origin HEAD:claude/project-thread-7rao18"
