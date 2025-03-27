FROM node:18.0.0

RUN  apt-get update;  apt-get install -y --no-install-recommends   ca-certificates   curl   netbase   wget  ;  rm -rf /var/lib/apt/lists/*     

COPY . /opt/

RUN yarn global add @force-bridge/cli@VERSION