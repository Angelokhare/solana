import './polyfills';    // 1st
import './index.css';    // 2nd (CRITICAL - Make sure this exists)
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// import Secret from './change/Sect';
// import Main from './hidden/Main';
// import Max from './iwithdraw/Max';
// import Solcenarate from './nopeeee/Solcenarate';




ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    {/* <Secret  /> */}
    {/* <Main /> */}
    {/* <Solcenarate /> */}
    {/* <Max /> */}

  </React.StrictMode>
);
