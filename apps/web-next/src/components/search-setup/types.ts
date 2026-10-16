export type Step = 'brief' | 'team' | 'sectors' | 'geography' | 'size' | 'fit' | 'transaction' | 'workflow' | 'review';
export type TextField = 'thesis' | 'buyerType' | 'firmName' | 'website' | 'teamSize' | 'geographyNotes' | 'currency' | 'otherCriteria' | 'extraExclusions' | 'timeline' | 'fundingStage' | 'ownerTransition' | 'dealVolume' | 'firstFocus' | 'searchName';
export type ListField = 'sectorsInclude' | 'geographies' | 'features' | 'hardExclusions' | 'transactionTypes' | 'sources';
export type MoneyField = 'revenueMin' | 'revenueMax' | 'ebitdaMin' | 'ebitdaMax' | 'dealSizeMin' | 'dealSizeMax';
export type BoolField = 'sectorOpen' | 'locationFlexible' | 'sizeFlexible';
export type Answers = Record<TextField, string> & Record<ListField, string[]> & Record<MoneyField, number | null> & Record<BoolField, boolean>;
export type Field = keyof Answers;
export type Change = <K extends Field>(field: K, value: Answers[K]) => void;
export interface Draft { answers: Answers; step: Step; touched: Field[] }
export interface SetupResponse {
  searchProfile: { answers: Answers; updatedAt: string } | null;
  searchSetup?: { status: 'draft' | 'skipped' | 'complete'; draft: Draft | null; updatedAt: string } | null;
  brief: string;
  warnings?: string[];
}
