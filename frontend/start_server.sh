#!/bin/bash
python3 -m http.server --bind 127.0.0.1 8001 &>/dev/null &
open http://127.0.0.1:8001

