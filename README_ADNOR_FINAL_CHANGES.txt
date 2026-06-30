ADNOR COMPLETE V5

هذه النسخة مبنية على V4 لكن مع تثبيت النقاط الناقصة:
- إزالة package-lock.json الخاص بـ Replit حتى لا يفشل Render بسبب package-firewall.replit.local.
- إضافة .npmrc لاستخدام registry الرسمي.
- تثبيت Node 20.x في package.json.
- واجهة الدخول للمستخدم صارت Google + الهاتف فقط، وإخفاء الإيميل/كلمة السر عن المستخدم.
- الإيداع يحتوي رفع إيصال بشكل مباشر، وموافقة الأدمن مطلوبة قبل إضافة الرصيد.
- ترتيب القائمة السفلية: اليانصيب، الألعاب، المحفظة، الدعم.
- الحفاظ على الأدمن، الدعوات، صندوق الحظ، العجلة، الدعم، حقن الأكواد، وجدولة السحب.

Render:
Build Command: npm install
Start Command: npm start
Health Check: /api/health
Environment Variables:
FIREBASE_DATABASE_URL
DRAW_TIMEZONE=Europe/Istanbul
ADMIN_TOKEN
SESSION_SECRET
