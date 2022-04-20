#!/bin/bash
declare -a arr=( $(cut -d '=' -f1 files.txt) )
touch ordered.txt
for index in "${!arr[@]}";
do
    wget -O "$index.mp4" "${arr[$index]}"
    echo "$index.mp4" >> ordered.txt
done
ffmpeg -f concat -i ordered.txt -vcodec copy -acodec copy output.mp4
declare -a ord=( $(cut -d '=' -f1 ordered.txt) )
for index in "${!ord[@]}";
do
    rm "$index.mp4"
done
rm ordered.txt
