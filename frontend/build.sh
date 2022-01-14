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

shutil.rmtree(config['DEFAULT']['BuildDirectory'], ignore_errors=True)
os.makedirs(os.path.dirname(config['DEFAULT']['BuildDirectory']), exist_ok=True)


# CSS
def css_process():
    print('Processing CSS files')
    css_contents = ""
    if config['DEFAULT']['CSSURLS'] != "":
        css_items = config['DEFAULT']['CSSURLS'].split(",")
    if len(css_items) >= 0:
        for css_item in css_items:
            r = requests.get(css_item)
            css_contents += r.text + '\n'

    for filename in os.listdir(config['DEFAULT']['CSSDirectory']):
        if filename.endswith(".css"):
            with open(config['DEFAULT']['CSSDirectory'] + filename, 'r') as file:
                css_data = file.read()
            css_contents += css_data + '\n'
        else:
            continue

    os.makedirs(os.path.dirname(config['DEFAULT']['CSSOutput']), exist_ok=True)
    css_file_write = open(config['DEFAULT']['CSSOutput'], "w+")

    if config['DEFAULT']['CompressCSS'] == 1:
        temp = css_file_write.write(compress(css_contents))
    else:
        temp = css_file_write.write(css_contents)

    css_file_write.close()
    print('Processing CSS files complete')


# JS
def js_process():
    print('Processing JS files')
    js_contents = ""
    if config['DEFAULT']['JSURLS'] != "":
        js_items = config['DEFAULT']['JSURLS'].split(",")

    if len(js_items) >= 0:
        for js_item in js_items:
            r = requests.get(js_item)
            js_contents += r.text + '\n'

    for filename in os.listdir(config['DEFAULT']['JSDirectory']):
        if filename.endswith(".js"):
            with open(config['DEFAULT']['JSDirectory'] + filename, 'r') as file:
                js_data = file.read()
            js_contents += js_data + '\n'
        else:
            continue
    os.makedirs(os.path.dirname(config['DEFAULT']['JSOutput']), exist_ok=True)
    js_file_write = open(config['DEFAULT']['JSOutput'], "w+")

    if config['DEFAULT']['CompressJS'] == 1:
        temp = js_file_write.write(jsmin(js_contents))
    else:
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


# Additional resource Files
def resource_process():
    print('Processing Resource files')
    os.makedirs(os.path.dirname(config['DEFAULT']['ImgOutputDirectory']), exist_ok=True)
    for root, dirs, files in os.walk(config['DEFAULT']['ImgDirectory']):
        for file in files:
            path_file = os.path.join(root, file)
            shutil.copy2(path_file, config['DEFAULT']['ImgOutputDirectory'])  # change you destination dir

    destination = shutil.copytree(config['DEFAULT']['RsrcDirectory'], config['DEFAULT']['RsrcOutputDirectory'])
    print('Processing Resource files complete')


if __name__ == '__main__':
    css_process()
    js_process()
    html_process()
    root_process()
    resource_process()
