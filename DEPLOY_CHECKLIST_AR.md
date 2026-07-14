# قائمة النشر السريعة

1. فك ضغط الملف.
2. ارفع كل المحتويات إلى جذر GitHub واستبدل الملفات القديمة.
3. تأكد أنه لا يوجد `package.json` ولا مجلد `functions`.
4. في Render:
   - Root Directory: فارغ
   - Build Command: `echo "ADNOR Firebase Only"`
   - Publish Directory: `.`
5. نفّذ Clear build cache & deploy.
6. افتح `/deploy-check.txt` وتأكد من ظهور V302.
7. انشر قواعد `FIREBASE_DATABASE_RULES_COPY.json` في Realtime Database.
8. انشر قواعد `FIREBASE_STORAGE_RULES_COPY.txt` في Storage.
9. فعّل Google وPhone وEmail/Password من Authentication حسب الحاجة.
10. ادخل `/admin.html` بحساب الأدمن واضبط مواعيد السحوبات وطرق الدفع.
