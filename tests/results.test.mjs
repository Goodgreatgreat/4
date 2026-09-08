import test from 'node:test';
import assert from 'node:assert/strict';
import {resultView} from '../results.js';
const e={id:'a',account:'a',symbol:'2330',name:'台積電',market:'TW',kind:'buy',date:'2024-12-01',order:1,price:100,quantity:10,fee:0,tax:0};
function view(extra={}){return resultView({entries:[e],stock:'TW:2330',mode:'year',period:'2025',start:'2025-01-01',end:'2025-12-31',field:(label,name)=>`<label>${label}<input name="${name}"></label>`,esc:v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),cash:v=>String(v),pct:v=>(v*100).toFixed(2)+'%',metric:(label,value)=>`<p>${label}: ${value}</p>`,tone:()=>'',choices:[['TW:2330','2330 台積電']],quotes:{},prices:{},accountName:()=> '帳戶 A',...extra});}
test('成果輸出提供股票與自訂起訖篩選，缺價明示',()=>{const html=view({mode:'range'});for(const name of ['report-stock','report-start','report-end','opening-price','ending-price'])assert.ok(html.includes(`name="${name}"`));assert.ok(html.includes('請補齊期初股價、期末股價'));assert.ok(html.includes('期間已實現損益: 0'));});
test('手動邊界價格只對相同股票與區間生效',()=>{const key=JSON.stringify(['TW:2330','2025-01-01','2025-12-31']);const prices={[key]:{opening:{close:100,date:'2024-12-31'},ending:{close:110,date:'2025-12-31'}}};assert.ok(view({prices}).includes('這段期間的資金加權報酬: 10.00%'));assert.ok(view({prices,period:'2024'}).includes('尚缺歷史股價'));});
test('今天的行情不能自動冒充歷史期末價',()=>{const html=view({quotes:{'TW:2330':{close:999,date:'2026-09-01'}}});assert.ok(html.includes('請補齊期初股價、期末股價'));});
test('空白或無效日期只顯示篩選錯誤，不破壞頁面',()=>{const html=view({mode:'range',start:''});assert.ok(html.includes('role="alert"'));assert.ok(html.includes('name="report-stock"'));});
