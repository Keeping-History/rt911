#!/bin/bash
python3 -m http.server --directory build --bind 127.0.0.1 8000 &>/dev/null &
open http://127.0.0.1:8000
