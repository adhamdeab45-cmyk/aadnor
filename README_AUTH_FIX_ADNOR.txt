ADNOR AUTH FIX — 2026-06-30

تم تركيب إصلاح نهائي لتسجيل الدخول داخل public/index.html:
1) Google صار يمسك الزر من أول نقرة ويستخدم redirect ثابت بدل تضارب popup/redirect.
2) Phone OTP صار يستخدم زر واحد واضح، reCAPTCHA ظاهر، وتأكيد الكود محفوظ.
3) تم منع تضارب باتشات V7 / V8.2 / V8.3 / V8.7 عن طريق capture click handler.
4) إذا الموقع مفتوح داخل Replit Preview أو iframe، الكود يفتح الموقع بتبويب كامل لأن Google و reCAPTCHA غالبًا لا يعملان داخل Preview.

مهم جدًا بعد رفع النسخة على Replit:
- افتح الموقع من التبويب الكامل وليس داخل Preview فقط.
- في Firebase Console > Authentication > Sign-in method: فعّل Google و Phone.
- في Firebase Console > Authentication > Settings > Authorized domains: أضف دومين الموقع الذي يظهر داخل رسالة الخطأ، مثل دومين replit.app أو دومينك الخاص.
- في Google Cloud OAuth Client تأكد من وجود redirect URI:
  https://adhamnnn-8a4d2.firebaseapp.com/__/auth/handler
  ويمكن إضافة:
  https://adhamnnn-8a4d2.web.app/__/auth/handler

الملف المعدل الأساسي:
public/index.html
