# Process roles for buildpack platforms (Heroku, Render, Railway). Both run from
# the same build; `release` applies pending migrations before the new release
# goes live. Docker platforms use the Dockerfile instead and set these commands
# per service.
web: npm start
worker: npm run start:worker
release: npm run migrate:deploy
