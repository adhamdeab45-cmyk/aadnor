'use strict';
module.exports=[
  {ignores:['**/node_modules/**']},
  {
    files:['assets/js/**/*.js','sw.js'],
    languageOptions:{ecmaVersion:2022,sourceType:'script',globals:{
      window:'readonly',document:'readonly',firebase:'readonly',UI:'readonly',ADNOR:'readonly',I18N:'readonly',console:'readonly',navigator:'readonly',location:'readonly',localStorage:'readonly',sessionStorage:'readonly',crypto:'readonly',fetch:'readonly',alert:'readonly',confirm:'readonly',prompt:'readonly',open:'readonly',Image:'readonly',FileReader:'readonly',File:'readonly',Blob:'readonly',URL:'readonly',URLSearchParams:'readonly',setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',Intl:'readonly',Event:'readonly',CustomEvent:'readonly',btoa:'readonly',atob:'readonly',screen:'readonly',self:'readonly',caches:'readonly'
    }},
    rules:{'no-undef':'error'}
  },
  {
    files:['functions/**/*.js','scripts/**/*.js'],
    languageOptions:{ecmaVersion:2022,sourceType:'commonjs',globals:{require:'readonly',module:'readonly',exports:'readonly',__dirname:'readonly',__filename:'readonly',process:'readonly',console:'readonly',Buffer:'readonly',setTimeout:'readonly',clearTimeout:'readonly',setInterval:'readonly',clearInterval:'readonly',Intl:'readonly',URL:'readonly'}},
    rules:{'no-undef':'error'}
  }
];
