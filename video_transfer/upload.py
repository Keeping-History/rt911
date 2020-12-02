import csv
import boto3
from botocore.exceptions import NoCredentialsError
import urllib.request
from urllib.parse import urlparse
import os

ACCESS_KEY = 'AKIAJ2VX3G2NN3QUN4GA'
SECRET_KEY = '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'
BUCKET_NAME = 'videos.911realtime.org'
URL_LIST = 'https://s3.amazonaws.com/videos.911realtime.org/files.txt'

def download_http_file(url, filename):
    print(os.getcwd())
    urllib.request.urlretrieve(url, '/src/' + filename)

def isModified(key, fname):
  s3 = boto3.resource('s3')
  obj = s3.Object(BUCKET_NAME, key)
  return int(obj.last_modified.strftime('%s')) != int(os.path.getmtime(fname))

def upload_to_aws(local_file, bucket, key):

    s3 = boto3.client('s3', aws_access_key_id=ACCESS_KEY,
                      aws_secret_access_key=SECRET_KEY)

    try:
        s3.upload_file('/src/' + local_file, bucket, key, ExtraArgs={'ACL':'public-read'})
        print("Upload Successful")
        return True
    except FileNotFoundError:
        print("The file was not found")
        return False
    except NoCredentialsError:
        print("Credentials not available")
        return False
print("+++++")
print("Downloading file list: " + URL_LIST)
url_list_downloaded = download_http_file(URL_LIST, 'files.txt')

print("+++++")
print("File list. contents: " + URL_LIST)
with open('/src/files.txt', 'r') as f:
    print(f.read())
print("+++++")

with open('/src/files.txt') as file:
    for url_item in file: 
        firstpos = url_item.rfind("/")
        lastpos = len(url_item)
        filename = url_item[firstpos+1:lastpos].rstrip().lstrip()
        url_path = urlparse(url_item).path.lstrip('/').rstrip()

        print("+++++")
        print("Current URL: " + url_item)
        print("Current URLPath: " + url_path)
        print("Current Filename: " + filename)
        print("+++++")


        print("+++++")
        print("Downloading " + url_item)
        print("+++++")

        download_http_file(url_item, filename)

        print("+++++")
        print("Downloaded " + url_item)
        print("+++++")

        print("+++++")
        print("Upload to AWS " + url_item)
        print("+++++")

        upload_to_aws(filename, BUCKET_NAME, url_path)
        print("+++++")
        print("Uploaded to AWS!!! " + url_item)
        print("+++++")

        os.remove(filename)

os.remove('files.txt')
