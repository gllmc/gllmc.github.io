# Guillaume Chirache's personal website

This repository hosts the code for my [personal website](https://chirache.fr). It uses the [Zola](https://www.getzola.org) static site generator and the [Tailwind CSS](https://tailwindcss.com) framework.

## Local development

Prerequisites: Zola (`pacman -S zola`) and Node.js (24+).

Install Tailwind CSS and the development dependencies with `npm install`.

Use `npm run watch` to launch both the Zola development server and the tailwind CLI watch process. The local development website is then served at [http://127.0.0.1:1111](http://127.0.0.1:1111).

## Deployment

Deployment on my server is performed on each push using GitHub Actions. See `.github/workflows/deploy.yml`.
