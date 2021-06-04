#!/usr/local/bin/python3

import os
import requests
import configparser
import shutil

from csscompressor import compress
from jsmin import jsmin
from htmlmin import minify

config = configparser.ConfigParser()
config.read('build.ini')

build_dir = config['DEFAULT']['BuildDirectory']
css_dir = config['DEFAULT']['CSSDirectory']
js_dir = config['DEFAULT']['JSDirectory']
img_dir = config['DEFAULT']['ImgDirectory']
rsrc_dir = config['DEFAULT']['RsrcDirectory']
html_file = config['DEFAULT']['HTMLFile']

css_output = config['DEFAULT']['CSSOutput']
js_output = config['DEFAULT']['JSOutput']
img_dir_output = config['DEFAULT']['ImgOutputDirectory']
rsrc_dir_output = config['DEFAULT']['RsrcOutputDirectory']
html_file_output = config['DEFAULT']['HTMLFileOutput']
root_files, css_items, js_items, css_contents, js_contents, html_contents = "", "", "", "", "", ""

shutil.rmtree(build_dir, ignore_errors=True)
os.makedirs(os.path.dirname(build_dir), exist_ok=True)

if config['DEFAULT']['CSSURLS'] != "":
    css_items = config['DEFAULT']['CSSURLS'].split(",")
if config['DEFAULT']['JSURLS'] != "":
    js_items = config['DEFAULT']['JSURLS'].split(",")
if config['DEFAULT']['RootFiles'] != "":
    root_files = config['DEFAULT']['RootFiles'].split(",")

if len(css_items) >= 0:
    for css_item in css_items:
        r = requests.get(css_item)
        css_contents += r.text + '\n'

if len(js_items) >= 0:
    for js_item in js_items:
        r = requests.get(js_item)
        js_contents += r.text + '\n'

if len(root_files) >= 0:
    for root_file in root_files:
        shutil.copyfile('./src/' + root_file, build_dir + root_file)

for filename in os.listdir(css_dir):
    if filename.endswith(".css"):
        with open(css_dir + filename, 'r') as file:
            css_data = file.read()
        css_contents += css_data + '\n'
    else:
        continue

for filename in os.listdir(js_dir):
    if filename.endswith(".js"):
        with open(js_dir + filename, 'r') as file:
            js_data = file.read()
        js_contents += js_data + '\n'
    else:
        continue


os.makedirs(os.path.dirname(css_output), exist_ok=True)
css_file_write = open(css_output, "w+")
temp = css_file_write.write(compress(css_contents))
css_file_write.close()

os.makedirs(os.path.dirname(js_output), exist_ok=True)
js_file_write = open(js_output, "w+")
temp = js_file_write.write(jsmin(js_contents))
js_file_write.close()

os.makedirs(os.path.dirname(img_dir_output), exist_ok=True)
# replace the . with your starting directory
for root, dirs, files in os.walk(img_dir):
    for file in files:
        path_file = os.path.join(root, file)
        shutil.copy2(path_file, img_dir_output)  # change you destination dir

destination = shutil.copytree(rsrc_dir, rsrc_dir_output)

with open(html_file, 'r') as file:
    html_data = file.read()
html_contents = minify(html_data)

html_file_write = open(html_file_output, "w+")
temp = html_file_write.write(html_contents)
html_file_write.close()
