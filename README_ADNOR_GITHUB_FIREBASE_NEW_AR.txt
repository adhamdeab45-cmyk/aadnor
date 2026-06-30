ADNOR GitHub Ready — Firebase جديد

تم تجهيز هذه النسخة على Firebase الجديد:
- projectId: adhamnnn-8a4d2
- authDomain: adhamnnn-8a4d2.firebaseapp.com
- databaseURL: https://adhamnnn-8a4d2-default-rtdb.firebaseio.com
- storageBucket: adhamnnn-8a4d2.firebasestorage.app

تسجيل الدخول في هذه النسخة:
- Google فقط
- Apple فقط
- لا يوجد تسجيل هاتف
- لا يوجد Email/Password

الأدمن الرئيسي:
- adhamdeab2@gmail.com
بعد دخوله يتم فتح لوحة الأدمن تلقائياً، ويتم حفظه داخل users و admins في Realtime Database.

قبل رفع الموقع وتشغيله:
1) Firebase Authentication > Sign-in method:
   - فعّل Google
   - فعّل Apple
   - اترك Phone و Email/Password متوقفين

2) Firebase Authentication > Settings > Authorized domains:
   أضف دومين GitHub Pages أو الدومين الذي سيظهر عند النشر.
   مثال GitHub Pages عادة يكون:
   username.github.io

3) Realtime Database > Rules:
   للتجربة ضع قواعد auth != null كما اتفقنا.
   بعد التأكد من الدخول والمحفظة نرجع لقواعد أقوى.

ملاحظة مهمة عن Apple:
Apple داخل Firebase يحتاج إعدادات Apple Developer حتى يعمل على الويب بشكل صحيح.
إذا Google اشتغل وApple لم يشتغل، فهذا غالباً من إعداد Apple Developer وليس من كود ADNOR.

لا ترفع إلى GitHub:
- Service Account private key
- كلمات سر Gmail
- App Password
- أي أسرار خاصة
