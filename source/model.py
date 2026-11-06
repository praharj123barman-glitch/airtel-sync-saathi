import sys, pandas as pd, numpy as np
D=sys.argv[1]
L=pd.read_csv(f"{D}/smb_leads.csv")
y=(L.outcome=="Activated").astype(int)
L["n_interest"]=L.products_of_interest.fillna("").str.count(";")+1
cat=["segment","lead_source","city_tier","preferred_language","annual_turnover_band","has_gstin","has_udyam","current_internet","current_provider","contact_role"]
num=["employee_count","num_sites","monthly_telecom_spend_inr","n_interest"]
X=pd.get_dummies(L[cat].astype(str)).join(L[num])
try:
    from sklearn.model_selection import cross_val_predict, StratifiedKFold
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
    cv=StratifiedKFold(5,shuffle=True,random_state=7)
    for name,m in [("logreg",make_pipeline(StandardScaler(),LogisticRegression(max_iter=2000,C=0.3))),("hgb",HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=200))]:
        p=cross_val_predict(m,X,y,cv=cv,method="predict_proba")[:,1]
        auc=roc_auc_score(y,p)
        order=np.argsort(-p); yy=y.values[order]
        for top in [0.1,0.2,0.3]:
            k=int(len(yy)*top); print(name,f"AUC {auc:.3f} top{int(top*100)}% captures {yy[:k].sum()/yy.sum():.1%} of activations, rate {yy[:k].mean():.1%}")
    m=make_pipeline(StandardScaler(),LogisticRegression(max_iter=2000,C=0.3)).fit(X,y)
    coef=pd.Series(m[-1].coef_[0],index=X.columns).sort_values()
    print(coef.head(8)); print(coef.tail(8))
except ImportError as e:
    print("no sklearn", e)

# impact simulation: recover share of process-driven drops
drops=L[L.outcome=="Dropped"].groupby(["stage_reached","drop_reason"]).size()
stages=["Lead","Contacted","Needs assessed","Quote accepted","KYC complete"]
reached=[5000,3406,1974,861,588,368]
addr={"Owner had no time for a visit":"Contacted","Visit not scheduled by sales":"Contacted",
"Quote too complex to understand":"Needs assessed","Quote took too long to arrive":"Needs assessed",
"Missing GST or Udyam document":"Quote accepted","Found paperwork too long":"Quote accepted","Authorised signatory not available":"Quote accepted","Document details did not match":"Quote accepted",
"Installation delayed beyond 21 days":"KYC complete","Site not feasible for fibre":"KYC complete","First payment failed":"KYC complete"}
for share in [0.3,0.5]:
    conv=[]
    for i,s in enumerate(stages):
        rec=sum(drops.get((s,r),0) for r,st in addr.items() if st==s)
        conv.append((reached[i+1]+share*rec)/reached[i])
    tot=np.prod(conv)
    print(f"recover {share:.0%}: conv per stage {[round(c,3) for c in conv]} -> activation {tot:.1%}, acts per 5000 {tot*5000:.0f}, CAC at same spend {L.acquisition_cost_inr.sum()/(tot*5000):.0f}")
print("addressable drops", sum(drops.get((st,r),0) for r,st in addr.items()), "of", int((L.outcome=='Dropped').sum()))
print("acq spend share by segment", (L.groupby('segment').acquisition_cost_inr.sum()/L.acquisition_cost_inr.sum()).round(3).to_dict())
print("field sales leads by segment", L[L.lead_source=='Field sales'].segment.value_counts(normalize=True).round(3).to_dict())
A=L[L.outcome=="Activated"]
print("activations on cancelled/suspended gstin")
G=pd.read_csv(f"{D}/mock_gstin_registry.csv"); m=A.merge(G[["gstin","status"]],on="gstin",how="left"); print(m.status.value_counts(dropna=False))
