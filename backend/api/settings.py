import os
import pymysql
from dotenv import load_dotenv

load_dotenv()  # loads the configs from .env

pymysql.version_info = (1, 4, 6, 'final', 0)
pymysql.install_as_MySQLdb()

# Build paths inside the project like this: os.path.join(BASE_DIR, ...)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRET_KEY = str(os.getenv('DJANGO_SECRET_KEY'))
DEBUG = str(os.getenv('DJANGO_DEBUG'))
ALLOWED_HOSTS = os.environ.get('DJANGO_ALLOWED_HOSTS').split(' ')

# Application definition
ROOT_URLCONF = 'api.urls'
WSGI_APPLICATION = 'api.wsgi.application'
CORS_ORIGIN_ALLOW_ALL = True
INSTALLED_APPS = [
    'media.apps.mediaConfig',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'corsheaders',
    'rangefilter',
    'import_export',
    'six',
]
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

# Database
# https://docs.djangoproject.com/en/2.1/ref/settings/#databases

# Install PyMySQL as mysqlclient/MySQLdb to use Django's mysqlclient adapter
# See https://docs.djangoproject.com/en/2.1/ref/databases/#mysql-db-api-drivers
# for more information
# [START db_setup]
if os.getenv('GAE_APPLICATION', None):
    # Running on production App Engine, so connect to Google Cloud SQL using
    # the unix socket at /cloudsql/<your-cloudsql-connection string>
    DATABASES = {
        'default': {
            'ENGINE': str(os.getenv('DJANGO_DB_CLOUD_ENGINE', '')),
            'HOST': str(os.getenv('DJANGO_DB_CLOUD_HOST', '')),
            'USER': str(os.getenv('DJANGO_DB_CLOUD_USER', '')),
            'PASSWORD': str(os.getenv('DJANGO_DB_CLOUD_PASSWORD', '')),
            'NAME': str(os.getenv('DJANGO_DB_CLOUD_NAME', '')),
        }
    }
else:
    # Running locally so connect to either a local MySQL instance or connect to
    # Cloud SQL via the proxy. To start the proxy via command line:
    #
    #     $ cloud_sql_proxy -instances=[INSTANCE_CONNECTION_NAME]=tcp:3306
    #
    # See https://cloud.google.com/sql/docs/mysql-connect-proxy
    DATABASES = {
        'default': {
            'ENGINE': str(os.getenv('DJANGO_DB_LOCAL_ENGINE', '')),
            'HOST': str(os.getenv('DJANGO_DB_LOCAL_HOST', '')),
            'PORT': int(os.getenv('DJANGO_DB_LOCAL_PORT', 0)),
            'USER': str(os.getenv('DJANGO_DB_LOCAL_USER', '')),
            'PASSWORD': str(os.getenv('DJANGO_DB_LOCAL_PASSWORD', '')),
            'NAME': str(os.getenv('DJANGO_DB_LOCAL_NAME', '')),
        }
    }
# [END db_setup]

# Password validation
# https://docs.djangoproject.com/en/3.0/ref/settings/#auth-password-validators
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


# Internationalization
# https://docs.djangoproject.com/en/3.0/topics/i18n/
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_L10N = True
USE_TZ = True

# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/3.0/howto/static-files/
STATIC_ROOT = os.path.join(BASE_DIR, 'static')
STATIC_URL = '/static/'
CORS_ORIGIN_ALLOW_ALL = True
CORS_ORIGIN_WHITELIST = (
    'https://*',
    'http://*',
)
