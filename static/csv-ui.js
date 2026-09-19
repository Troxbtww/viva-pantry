/* Import reviewed foods or dated reference prices through the private item API. */
'use strict';
let csvImportBusy=false;

function csvFoodKey(item){
  return [item.name.trim().toLocaleLowerCase(),item.package_size??'',item.package_unit,item.pack_count||1].join('|');
}
function csvPriceMatch(row,items,observedOn,kind){
  const amount=row.reference_price;
  if(typeof amount!=='number'||!Number.isFinite(amount)||amount<=0)return {reason:'No reference price was recorded in this CSV row.'};
  if(Math.abs(amount*100-Math.round(amount*100))>0.000001)return {reason:'The reference price has more than two decimal places; check it manually.'};
  const matches=items.filter(item=>csvFoodKey(item)===csvFoodKey(row.item));
  if(!matches.length)return {reason:'No exact food and pack match in your library. Add or check the food first.'};
  if(matches.length>1)return {reason:'More than one food has this name and pack size. Choose the correct item manually.'};
  const item=matches[0],sameDate=(item.prices||[]).filter(price=>price.observed_on===observedOn&&price.kind===kind);
  if(sameDate.some(price=>Math.round(Number(price.price)*100)!==Math.round(amount*100)))return {item,reason:'A different price of this type is already recorded on this date. Check the item’s history manually.'};
  const existing=sameDate.find(price=>Math.round(Number(price.price)*100)===Math.round(amount*100));
  return {item,existing,reason:existing?'This amount, date, and price type are already recorded.':''};
}
function csvDatedNotes(item,row,observedOn,kind){
  const original=String(row.item.notes||'').split('\n\n').find(note=>/^Undated reference price: AED [\d.]+\. From the CSV; not added to weekly price history\.$/.test(note));
  const notes=String(item.notes||'');
  if(!original)return notes;
  const replacement=`${kind[0].toUpperCase()+kind.slice(1)} reference price: AED ${Number(row.reference_price).toFixed(2)} on ${observedOn}. From the CSV; added to weekly price history.`;
  return notes.split('\n\n').map(note=>note===original?replacement:note).join('\n\n');
}
function openCSVImport(){
  let rows=[];
  document.querySelector('#small-content').innerHTML=`<header class="dialog-header"><div><h2 id="small-title">Bring your food list.</h2><p>Import foods or add dated prices to foods already in your library.</p></div><button class="icon-button" data-action="close-small" aria-label="Close CSV import">${icon('close')}</button></header>
  <div class="dialog-body"><label class="field"><span>Import mode</span><select id="csv-mode"><option value="foods">Add foods</option><option value="prices">Record prices for existing foods</option></select></label>
  <div id="csv-price-fields" class="form-grid" style="margin:14px 0;display:none" hidden><label class="field"><span>Price observation date</span><input id="csv-price-date" type="date"></label><label class="field"><span>Price type</span><select id="csv-price-kind"><option value="regular">Regular shelf price</option><option value="offer">Special offer</option><option value="paid">What I paid</option></select></label></div>
  <label class="button secondary" for="csv-file" tabindex="0" role="button" style="margin-top:18px">${icon('document')}Choose a CSV</label><input class="hidden-file" id="csv-file" type="file" accept=".csv,text/csv">
  <label class="field" style="margin-top:18px"><span>Source filename</span><input id="csv-filename" value="Food database.csv" maxlength="150"></label>
  <label class="field" style="margin-top:14px"><span>CSV contents</span><textarea id="csv-text" rows="5" placeholder="Choose a file above, or paste the CSV text here." spellcheck="false"></textarea></label>
  <p class="form-help" id="csv-help"></p>
  <button class="button secondary" id="csv-preview" type="button">Review foods</button><div id="csv-status" class="photo-status" role="status"></div><div id="csv-preview-rows"></div></div>
  <footer class="dialog-footer"><div class="dialog-footer-actions"><button class="button secondary" data-action="close-small">Close</button><button class="button primary" id="csv-save" type="button" disabled>Import selected foods</button></div></footer>`;
  const textInput=document.querySelector('#csv-text'),filename=document.querySelector('#csv-filename'),fileInput=document.querySelector('#csv-file');
  const status=document.querySelector('#csv-status'),preview=document.querySelector('#csv-preview-rows'),save=document.querySelector('#csv-save');
  const mode=document.querySelector('#csv-mode'),priceDate=document.querySelector('#csv-price-date'),priceKind=document.querySelector('#csv-price-kind'),review=document.querySelector('#csv-preview');
  const priceMode=()=>mode.value==='prices';
  const selectedRows=()=>[...preview.querySelectorAll('input[data-csv-row]:checked')].map(input=>rows[Number(input.dataset.csvRow)]);
  const setBusy=busy=>{
    csvImportBusy=busy;
    smallDialog.querySelectorAll('button,input,textarea,select').forEach(control=>{control.disabled=busy;});
    if(!busy){
      preview.querySelectorAll('input[data-csv-row]').forEach(input=>{input.disabled=Boolean(rows[Number(input.dataset.csvRow)]?.skip);});
      save.disabled=!selectedRows().length;
    }
  };
  const invalidate=()=>{rows=[];preview.innerHTML='';status.textContent='';save.disabled=true;};
  const modeChanged=()=>{
    invalidate();
    document.querySelector('#csv-price-fields').hidden=!priceMode();
    document.querySelector('#csv-price-fields').style.display=priceMode()?'grid':'none';
    review.textContent=priceMode()?'Review prices':'Review foods';
    save.textContent=priceMode()?'Save selected prices':'Import selected foods';
    document.querySelector('#csv-help').textContent=priceMode()?'Matches the exact food name and pack in your library. Nutrition and photos are preserved. Existing prices and conflicts are skipped; source notes stay with each price.':'Supports the Food, Package qty, Package unit, Nutrition basis qty and nutrient columns from a food database export. Undated prices stay in notes until you confirm an observation date. Existing matching foods are skipped.';
  };
  const validatePriceSettings=()=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(priceDate.value)||!priceDate.checkValidity()||Number.isNaN(Date.parse(`${priceDate.value}T00:00:00Z`)))throw new Error('Choose the date these prices were observed.');
    if(!['regular','offer','paid'].includes(priceKind.value))throw new Error('Choose a regular, offer, or paid price type.');
  };
  mode.addEventListener('change',modeChanged);modeChanged();
  textInput.addEventListener('input',invalidate);filename.addEventListener('input',invalidate);priceDate.addEventListener('input',invalidate);priceKind.addEventListener('change',invalidate);
  preview.addEventListener('change',()=>{save.disabled=!selectedRows().length;});
  fileInput.addEventListener('change',async()=>{
    if(csvImportBusy)return;
    const file=fileInput.files[0];if(!file)return;
    invalidate();
    if(file.size>2*1024*1024){status.textContent='Choose a CSV smaller than 2 MB.';return;}
    setBusy(true);
    try{textInput.value=await file.text();filename.value=file.name;}catch{status.textContent='The file could not be read. Try pasting its CSV contents.';}
    finally{fileInput.value='';setBusy(false);}
  });
  review.addEventListener('click',async()=>{
    if(csvImportBusy)return;
    invalidate();setBusy(true);
    try{
      if(priceMode())validatePriceSettings();
      rows=window.PantryCSV.parse(textInput.value,filename.value||'Food database.csv');
      await refreshItems();
      const seen=new Set(priceMode()?[]:state.items.map(csvFoodKey));
      preview.innerHTML=rows.map((row,index)=>{
        const key=csvFoodKey(row.item),repeated=seen.has(key);seen.add(key);
        let reason='';
        if(priceMode()){
          const match=csvPriceMatch(row,state.items,priceDate.value,priceKind.value);
          row.noteRepair=!repeated&&Boolean(match.existing)&&csvDatedNotes(match.item,row,priceDate.value,priceKind.value)!==String(match.item.notes||'');
          reason=repeated?'This food and pack are repeated in the CSV.':row.noteRepair?'This price is already recorded. Only its undated source note will be updated.':match.reason;
        }
        else if(repeated)reason='Already in this library or repeated in this file.';
        row.skip=Boolean(reason)&&!row.noteRepair;
        const description=priceMode()?`${packageText(row.item)} · ${row.reference_price===null?'No price':`AED ${Number(row.reference_price).toFixed(2)}`} · ${priceDate.value} · ${priceKind.value}`:`${packageText(row.item)} · ${row.item.nutrition.basis}`;
        return `<div class="csv-food-row"><label><input type="checkbox" data-csv-row="${index}" ${row.skip?'disabled':'checked'}><span><strong>${e(row.item.name)}</strong><small>${e(description)}</small></span></label>${reason?`<p class="form-help">${e(reason)}</p>`:''}<details><summary>Nutrition and source notes</summary><p class="form-help">${row.item.nutrition.values.map(v=>`${e(v.label)}: ${e(v.value)} ${e(v.unit)}`).join(' · ')}</p><p class="item-notes">${e(row.item.notes)}</p>${row.warnings.length?`<p class="form-help">${row.warnings.map(e).join(' · ')}</p>`:''}</details></div>`;
      }).join('');
      const eligible=rows.filter(row=>!row.skip).length;
      const noteRepairs=rows.filter(row=>row.noteRepair).length;
      status.textContent=priceMode()?`${rows.length} foods found. ${eligible-noteRepairs} prices ready for ${priceDate.value} (${priceKind.value})${noteRepairs?`; ${noteRepairs} existing prices need only a source-note update`:''}; ${rows.length-eligible} skipped.`:`${rows.length} foods found. Nutrition and reference prices remain marked for your review. Photos can be added later.`;
    }catch(err){status.innerHTML=errorBox(err.message);}
    finally{setBusy(false);}
  });
  save.addEventListener('click',async()=>{
    if(csvImportBusy)return;
    const selected=selectedRows();
    if(!selected.length){status.textContent=priceMode()?'Select at least one price to save.':'Select at least one food to import.';return;}
    const importingPrices=priceMode(),observedOn=priceDate.value,kind=priceKind.value;
    try{if(importingPrices)validatePriceSettings();}catch(err){status.innerHTML=errorBox(err.message);return;}
    setBusy(true);
    let saved=0,skipped=0,repaired=0;
    try{
      await refreshItems();
      const known=new Set(state.items.map(csvFoodKey)),processed=new Set();
      for(const row of selected){
        const key=csvFoodKey(row.item);
        if(processed.has(key)){skipped++;continue;}processed.add(key);
        status.textContent=`${importingPrices?'Recording prices':'Importing foods'} ${saved+skipped+1} of ${selected.length}: ${row.item.name}…`;
        if(importingPrices){
          const match=csvPriceMatch(row,state.items,observedOn,kind);
          if(match.reason&&!match.existing){skipped++;continue;}
          const item=match.item;
          if(!match.existing){
            const sourceName=(filename.value||'Food database.csv').split(/[\\/]/).pop();
            const notes=[`Imported from ${sourceName}; observation date and ${kind} price type confirmed for this import.`,row.source_note?`Source / note: ${row.source_note}`:''].filter(Boolean).join('\n\n').slice(0,2000);
            const price=await api(`/api/items/${encodeURIComponent(item.id)}/prices`,{method:'POST',body:JSON.stringify({price:row.reference_price,observed_on:observedOn,kind,notes})});
            if(!price?.id||String(price.item_id)!==String(item.id)||price.observed_on!==observedOn||price.kind!==kind||Math.abs(Number(price.price)-row.reference_price)>0.000001||!Number.isFinite(Number(price.price)))throw new Error('The saved price could not be verified. Retry to check the library before saving again.');
            item.prices=[...(item.prices||[]),price];saved++;
          }else skipped++;
          const notes=csvDatedNotes(item,row,observedOn,kind);
          if(notes!==String(item.notes||'')){
            const updated=await api(`/api/items/${encodeURIComponent(item.id)}`,{method:'PUT',body:JSON.stringify({notes})});
            if(String(updated?.id)!==String(item.id)||updated.notes!==notes)throw new Error('The price is saved, but its source note could not be verified. Retry to repair the note without adding a second price.');
            item.notes=notes;if(match.existing)repaired++;
          }
        }else{
          if(known.has(key)){skipped++;continue;}
          const item=await api('/api/items',{method:'POST',body:JSON.stringify(row.item)});
          state.items.push(item);known.add(key);saved++;
        }
      }
      await refreshItems();
      status.textContent=importingPrices?`${saved} ${kind} prices saved for ${observedOn}${skipped?`; ${skipped} existing or conflicting rows skipped`:''}${repaired?`; ${repaired} source notes repaired`:''}. Nutrition and photos are preserved.`:`${saved} foods imported${skipped?`; ${skipped} already present and skipped`:''}. You can now add photos and check each food.`;
      preview.innerHTML='';rows=[];
    }catch(err){
      const result=importingPrices?`${saved} prices saved before the import stopped: ${err.message} Click Save selected prices to retry; existing prices are skipped and unfinished source notes are repaired.`:`${saved} foods imported before the import stopped: ${err.message} Click Import selected foods to retry; saved matches will be skipped.`;
      status.innerHTML=errorBox(result);
    }finally{
      setBusy(false);
      updateCounts();if((location.hash||'#library')==='#library')renderLibrary();
    }
  });
  smallDialog.showModal();
}
smallDialog.addEventListener('cancel',event=>{if(csvImportBusy)event.preventDefault();});
