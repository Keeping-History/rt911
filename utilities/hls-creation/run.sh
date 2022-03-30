for line in $(cat 'files.txt')
do
    target="${line##*/}" # leave only last component of path
    target="${target%.*}"  # strip extension
    if [ ! -f $target/playlist.m3u8 ]
    then
        ./create-hls-vod.sh "$line"
    fi
done
