#!/usr/bin/env python3

import os
import requests
import configparser
import shutil
import urllib.request

from csscompressor import compress
from jsmin import jsmin
from htmlmin import minify

config = configparser.ConfigParser()
config.read('build.ini')

shutil.rmtree(config['DEFAULT']['BuildDirectory'], ignore_errors=True)
os.makedirs(os.path.dirname(config['DEFAULT']['BuildDirectory']), exist_ok=True)


# CSS
def css_process():
    print('Processing CSS files')
    css_contents = ""
    if os.path.exists("./src/css/include.txt"):
        with open("./src/css/include.txt") as css_file:
            css_items = [css_item.rstrip() for css_item in css_file.readlines() if css_item.strip()]
    if len(css_items) >= 0:
        for css_item in css_items:
            r = requests.get(css_item)
            if config['DEFAULT']['CompressCSS'] == "1":
                css_contents += compress(r.text) + '\n'
            else:
                css_contents += r.text + '\n'

    for filename in os.listdir(config['DEFAULT']['CSSDirectory']):
        if filename.endswith(".css"):
            with open(config['DEFAULT']['CSSDirectory'] + filename, 'r') as file:
                css_data = file.read()
                if config['DEFAULT']['CompressCSS'] == "1":
                    css_contents += compress(css_data) + '\n'
                else:
                    css_contents += css_data + '\n'
        else:
            continue

    os.makedirs(os.path.dirname(config['DEFAULT']['CSSOutput']), exist_ok=True)
    css_file_write = open(config['DEFAULT']['CSSOutput'], "w+")

    temp = css_file_write.write(css_contents)

    css_file_write.close()
    print('Processing CSS files complete')


# JS
def js_process():
    print('Processing JS files')
    js_contents = ""
    if os.path.exists("./src/js/include.txt"):
        with open("./src/js/include.txt") as js_file:
            js_items = [js_item.rstrip() for js_item in js_file.readlines() if js_item.strip()]
    if len(js_items) >= 0:
        for js_item in js_items:
            r = requests.get(js_item)
            if config['DEFAULT']['CompressJS'] == "1":
                js_contents += jsmin(r.text) + '\n'
            else:
                js_contents += r.text + '\n'

    for filename in os.listdir(config['DEFAULT']['JSDirectory']):
        if filename.endswith(".js"):
            with open(config['DEFAULT']['JSDirectory'] + filename, 'r') as file:
                js_data = file.read()
                if config['DEFAULT']['CompressJS'] == "1":
                    js_contents += jsmin(js_data) + '\n'
                else:
                    js_contents += js_data + '\n'
        else:
            continue

    os.makedirs(os.path.dirname(config['DEFAULT']['JSOutput']), exist_ok=True)
    js_file_write = open(config['DEFAULT']['JSOutput'], "w+")

    temp = js_file_write.write(js_contents)

    js_file_write.close()
    print('Processing JS files complete')


#HTML
def html_process():
    print('Processing HTML files')
    with open(config['DEFAULT']['HTMLFile'], 'r') as file:
        html_data = file.read()
    html_contents = minify(html_data)

    html_file_write = open(config['DEFAULT']['HTMLFileOutput'], "w+")
    temp = html_file_write.write(html_contents)
    html_file_write.close()


#Files in root directory
def root_process():
    root_files = ""
    if config['DEFAULT']['RootFiles'] != "":
        root_files = config['DEFAULT']['RootFiles'].split(",")

    if len(root_files) >= 0:
        for root_file in root_files:
            shutil.copyfile('./src/' + root_file, config['DEFAULT']['BuildDirectory'] + root_file)
    print('Processing HTML files complete')


# Fire the processes
if __name__ == '__main__':
    css_process()
    js_process()
    html_process()
    root_process()
