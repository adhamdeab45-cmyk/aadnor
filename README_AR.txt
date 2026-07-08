ADNOR REPLIT NO ADMIN JSON
==========================

هذه نسخة خاصة لـ Replit تعمل بدون FIREBASE_SERVICE_ACCOUNT_JSON.
سببها أن Firebase منع إنشاء مفتاح Admin JSON عندك.

المهم:
- لا تضيف FIREBASE_SERVICE_ACCOUNT_JSON في Replit.
- السيرفر يستخدم Realtime Database REST API.
- السحب لا يتم تلقائياً بدون موافقة الأدمن.
- الساعة 8 السيرفر يضع الحالة: بانتظار موافقة الأدمن فقط.
- التنفيذ الحقيقي للسحب يكون من زر الأدمن: تنفيذ / نشر السحب.

Secrets المطلوبة فقط:
1) FIREBASE_DATABASE_URL=https://adnor-vp-default-rtdb.firebaseio.com
2) DRAW_TIMEZONE=Europe/Istanbul
3) ADMIN_TOKEN=ADNOR_ADMIN_2026_987654

تشغيل Replit:
1) تأكد أن الملفات موجودة:
   server.js
   package.json
   public/index.html

2) افتح Shell واكتب:
   npm install
   npm start

3) جرّب:
   /api/health

إذا ظهر ok:true فالسيرفر شغال.

ملاحظة عن Firebase Rules:
لأن هذه النسخة بدون Admin JSON، يجب أن تكون Realtime Database Rules تسمح للتجربة بالقراءة والكتابة.
بعد ما نثبت أن الموقع يعمل، نضبط Rules بشكل آمن أكثر.
