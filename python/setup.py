from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="vitrus",
    version="0.1.0",
    author="Vitrus Team",
    author_email="",
    description="Python client for interfacing with the Vitrus WebSocket server",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/vitrus/vitrus-sdk-python",
    packages=find_packages(),
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.7",
    install_requires=[
        "websockets>=10.0",
        "httpx>=0.24.0,<0.25.0",
        "zenoh",
    ],
)
