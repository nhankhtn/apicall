# ApiCall Runner: local dev, Docker image, registry push, Vercel deploy.
#
#   make dev                                         # API :3939 + Vite :5173
#   make docker-run APP_USER=admin APP_PASS=secret   # build and run the image on :3939
#   make publish GHCR=ghcr.io/<you>/apicall          # push to GitHub Container Registry
#   make push REGISTRY=myreg.azurecr.io              # push to any registry you are logged in to
#   make vercel-prod                                 # deploy to Vercel (production)

NAME := apicall
PORT ?= 3939
# Login for the deployed app (APICALL_USER / APICALL_PASSWORD). Empty = login off.
APP_USER ?=
APP_PASS ?=
# Extra host names served without login, comma separated (APICALL_ALLOWED_HOSTS).
HOSTS ?=
# Registry prefix for `make push`, e.g. myreg.azurecr.io or ghcr.io/me
REGISTRY ?=
IMAGE := $(if $(REGISTRY),$(REGISTRY)/$(NAME),$(NAME))
# GitHub Container Registry image for `make publish`, e.g. ghcr.io/me/apicall
GHCR ?=
GHCR_USER ?= $(firstword $(subst /, ,$(patsubst ghcr.io/%,%,$(GHCR))))
TAG := $(shell git rev-parse --short HEAD 2>/dev/null || echo local)-$(shell date +%Y%m%d%H%M%S)
VOLUME := $(NAME)-data

.DEFAULT_GOAL := help
.PHONY: help install dev build start cli clean docker docker-run docker-stop docker-logs image push ghcr-login publish vercel vercel-prod vercel-env

help:
	@echo 'Local:   install dev build start cli clean'
	@echo 'Docker:  docker docker-run docker-stop docker-logs'
	@echo 'Publish: image push publish (GitHub Container Registry)'
	@echo 'Vercel:  vercel vercel-prod vercel-env'
	@echo
	@echo 'Variables: PORT=$(PORT) APP_USER=<login> APP_PASS=<password> HOSTS=<a,b> REGISTRY=<prefix> GHCR=ghcr.io/<you>/$(NAME)'

# ---------- Local ----------

install:
	npm ci

dev:
	npm run dev

build:
	npm run build

start: build
	PORT=$(PORT) npm start

# Example: make cli ARGS='run ./Shop.postman_collection.json -e ./Local.postman_environment.json'
cli:
	node bin/cli.mjs $(ARGS)

clean:
	rm -rf dist

# ---------- Docker ----------

docker:
	docker build -t $(NAME):latest .

docker-run: docker docker-stop
	docker run -d --name $(NAME) --restart unless-stopped \
		-p $(PORT):3939 \
		-v $(VOLUME):/data \
		$(if $(APP_USER),-e APICALL_USER=$(APP_USER)) \
		$(if $(APP_PASS),-e APICALL_PASSWORD=$(APP_PASS)) \
		$(if $(HOSTS),-e APICALL_ALLOWED_HOSTS=$(HOSTS)) \
		$(NAME):latest
	@echo 'Running on http://localhost:$(PORT)'

docker-stop:
	-@docker rm -f $(NAME) >/dev/null 2>&1

docker-logs:
	docker logs -f $(NAME)

# ---------- Registry ----------

image:
	docker build -t $(IMAGE):$(TAG) -t $(IMAGE):latest .

push:
	@test -n "$(REGISTRY)" || { echo 'Usage: make push REGISTRY=myreg.azurecr.io (log in to it first)'; exit 1; }
	$(MAKE) image REGISTRY=$(REGISTRY)
	docker push $(IMAGE):$(TAG)
	docker push $(IMAGE):latest

ghcr-login:
	@test -n "$(GHCR)" || { echo 'Usage: make publish GHCR=ghcr.io/<you>/$(NAME)'; exit 1; }
	@PATH="$$HOME/.local/bin:$$PATH"; \
	command -v gh >/dev/null || { echo 'gh is not installed'; exit 1; }; \
	gh auth status >/dev/null 2>&1 || { echo 'Run once: gh auth login -s write:packages'; exit 1; }; \
	gh auth token | docker login ghcr.io -u $(GHCR_USER) --password-stdin

publish: ghcr-login
	docker build -t $(GHCR):$(TAG) -t $(GHCR):latest .
	docker push $(GHCR):$(TAG)
	docker push $(GHCR):latest

# ---------- Vercel ----------
# The Vercel deployment has the HTTP proxy only: no WebSocket, Socket.IO, MQTT or gRPC calls,
# and it cannot reach internal/VPN APIs. Set a login before sharing the URL (make vercel-env).

vercel:
	npx vercel

vercel-prod:
	npx vercel --prod

vercel-env:
	@test -n "$(APP_USER)" -a -n "$(APP_PASS)" || { echo 'Usage: make vercel-env APP_USER=admin APP_PASS=<password>'; exit 1; }
	-@npx vercel env rm APICALL_USER production --yes >/dev/null 2>&1
	-@npx vercel env rm APICALL_PASSWORD production --yes >/dev/null 2>&1
	@printf '%s' '$(APP_USER)' | npx vercel env add APICALL_USER production
	@printf '%s' '$(APP_PASS)' | npx vercel env add APICALL_PASSWORD production
	@echo 'Login set. Redeploy with: make vercel-prod'
