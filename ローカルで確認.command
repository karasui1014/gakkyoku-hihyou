#!/bin/bash
# ローカルでAI楽曲批評ツールを起動します
cd "$(dirname "$0")"
open "http://localhost:8934"
python3 -m http.server 8934
