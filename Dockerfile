# استخدم صورة Node.js الرسمية (إصدار 18.20.5)
FROM node:18.20.5

# ضبط مجلد العمل داخل الحاوية
WORKDIR /app

# انسخ ملفات package.json و package-lock.json
COPY package*.json ./

# ثبت الـ dependencies
RUN npm install

# انسخ كل ملفات المشروع
COPY . .

# تحقق من محتويات app/models/ (مع تجاهل الأخطاء)
RUN ls -l app/models/ || echo "app/models/ is empty or not found"

# افتح الـ port اللي هيشتغل عليه التطبيق (3000)
EXPOSE 3000

# الأمر اللي هيشغل التطبيق
CMD ["npm", "start"]