# نستبدل alpine بـ slim عشان bcrypt وغيره يشتغلوا بدون مشاكل
FROM node:20-slim

WORKDIR /app

# تثبيت Caddy + الأدوات اللازمة لبناء native modules (لو احتجنا)
RUN apt-get update && apt-get install -y caddy python3 make g++ && rm -rf /var/lib/apt/lists/*

# نسخ package.json وتثبيت الديبندنسيز
COPY package*.json ./
RUN npm install --only=production

# نسخ باقي الكود
COPY . .

# البورتات
EXPOSE 80 443 3000

# التشغيل
CMD sh -c "\
  if [ \"$NODE_ENV\" = \"production\" ]; then \
    echo 'Production Mode → Caddy + HTTPS + SSL'; \
    caddy run --config /app/Caddyfile --adapter caddyfile & node index.js; \
  else \
    echo 'Development Mode → Node.js only on :3000'; \
    node index.js; \
  fi"