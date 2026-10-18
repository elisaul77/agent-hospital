FROM node:22-alpine AS base
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Unit tests run inside Docker: docker build --target test .
FROM base AS test
COPY test ./test
RUN npm test

FROM base AS runtime
ENV HOSPITAL_MODE=demo \
    PORT=8700 \
    HOST=0.0.0.0
USER 1000:1000
EXPOSE 8700
CMD ["node", "src/server.js"]
